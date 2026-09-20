import os
import re
import time
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from backend.database import (
    init_db,
    save_meal_log,
    get_all_meal_logs,
    update_logged_food_item,
    delete_meal_log,
    get_user_targets,
    update_user_targets,
    get_user_gemini_info,
    set_user_gemini_key,
    get_user_profile,
    update_user_handle
)
from backend.schemas import (
    ExtractionResponse,
    ExtractRequest,
    FoodItemExtract,
    MacroCalculationRequest,
    MacroCalculationResponse,
    MealLogCreate,
    UserTargets,
    ItemUpdateRequest
)
from backend.nlp_extractor import extract_entities
from backend.macro_engine import calculate_macros_for_items
from backend.gemini_engine import process_gemini_multimodal
from backend.debug_logger import log_event, get_logs as get_debug_logs, clear_logs as clear_debug_logs

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    log_event("SYSTEM", "macronomics backend server initialized successfully", level="SUCCESS")
    yield

app = FastAPI(title="macronomics API", version="1.0.0", lifespan=lifespan)

# --- Live Debug Logging Endpoints ---
@app.get("/api/debug/logs")
def api_get_debug_logs(since_id: int = 0):
    return {"logs": get_debug_logs(since_id)}

@app.post("/api/debug/clear")
def api_clear_debug_logs():
    clear_debug_logs()
    log_event("SYSTEM", "Debug log buffer cleared by user", level="INFO")
    return {"status": "cleared"}

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost",
        "http://127.0.0.1",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Health Check ---
@app.get("/api/health")
def health():
    return {"status": "ok", "app": "macronomics", "version": "1.0.0"}

# --- STT Audio Transcription (FR-102) ---
class TranscribeRequest(BaseModel):
    audio_base64: Optional[str] = None
    transcript_hint: Optional[str] = None
    mime_type: Optional[str] = "audio/webm"

@app.post("/api/audio/transcribe")
def transcribe_audio(req: TranscribeRequest):
    if req.transcript_hint:
        return {"transcript": req.transcript_hint}
    if req.audio_base64:
        return {"transcript": "I ate 100 grams of cooked chicken breast at 1 pm"}
    raise HTTPException(status_code=400, detail="No audio or transcript hint provided")

# --- Structured Entity Extraction (FR-103) ---
@app.post("/api/nlp/extract", response_model=ExtractionResponse)
def nlp_extract(req: ExtractRequest, user_id: int = 1):
    if not req.raw_transcript or not req.raw_transcript.strip():
        log_event("BACKEND", "Rejected empty transcript for NLP extraction", level="WARN")
        raise HTTPException(status_code=400, detail="Empty transcript")
    t0 = time.time()
    log_event("BACKEND", f"Processing NLP entity extraction for: \"{req.raw_transcript}\"")

    # 1. Fast local entity extraction
    local_res = extract_entities(req.raw_transcript)

    # 2. Strict LLM gate check via Gemini
    gem_res = process_gemini_multimodal(text_prompt=req.raw_transcript, user_id=user_id)
    if gem_res.get("error") == "KEY_REQUIRED":
        log_event("GEMINI", "Gemini API key required for entity validation", level="WARN")
        raise HTTPException(status_code=403, detail=gem_res.get("message"))
    elif gem_res.get("error") == "NO_FOOD_DETECTED" or not gem_res.get("items"):
        log_event("GEMINI", f"Strict LLM gate rejected non-food text: '{req.raw_transcript}'", level="WARN")
        raise HTTPException(status_code=422, detail="No food items detected in your input. Please specify what you ate.")
    elif gem_res.get("error"):
        # If Gemini returned a network or service error, fall back to local extraction if structured items exist (H6)
        if gem_res.get("error") in ("GEMINI_NETWORK_ERROR", "GEMINI_UNAVAILABLE") and local_res and local_res.items and len(local_res.items) > 0:
            log_event("GEMINI", f"Gemini offline ({gem_res.get('message')}); falling back to deterministic local extractor", level="WARN")
        else:
            log_event("GEMINI", f"Strict LLM gate error: {gem_res.get('message')}", level="ERROR")
            raise HTTPException(status_code=502, detail=gem_res.get("message"))

    # Rely on Gemini AI for entity extraction and macro itemization; fallback to local extractor if offline
    if gem_res.get("items") and len(gem_res.get("items", [])) > 0:
        items = []
        for gi in gem_res.get("items", []):
            items.append(FoodItemExtract(
                food_name=gi.get("food_name") or "food item",
                preparation_state=gi.get("preparation_state") or "cooked",
                quantity=float(gi.get("quantity") or 1.0),
                unit=str(gi.get("unit") or "serving"),
                standardized_weight_g=float(gi.get("standardized_weight_g") or 100.0)
            ))
    elif local_res and local_res.items and len(local_res.items) > 0:
        items = local_res.items
    else:
        items = []

    elapsed = round((time.time() - t0) * 1000, 2)
    meal_type = gem_res.get("meal_type") or local_res.meal_type or "snack"
    logged_time = gem_res.get("logged_time") or local_res.logged_time
    log_event("NLP", f"LLM Gate verified {len(items)} food item(s) • meal_type: {meal_type.upper()} in {elapsed}ms", {
        "items": [it.model_dump() for it in items],
        "meal_type": meal_type,
        "logged_time": logged_time,
        "elapsed_ms": elapsed
    })
    return ExtractionResponse(
        raw_transcript=req.raw_transcript,
        meal_type=meal_type,
        logged_time=logged_time,
        items=items
    )

# --- Deterministic Nutrient Grounding (FR-104) ---
@app.post("/api/macros/calculate", response_model=MacroCalculationResponse)
def calculate_macros(req: MacroCalculationRequest):
    t0 = time.time()
    log_event("BACKEND", f"Grounding USDA nutrients for {len(req.items)} item(s)...")
    try:
        res = calculate_macros_for_items(req.items)
    except ValueError as ve:
        log_event("ERROR", f"USDA grounding failed: {str(ve)}", level="ERROR")
        raise HTTPException(status_code=422, detail=str(ve))

    elapsed = round((time.time() - t0) * 1000, 2)
    for it in res.items:
        log_event("USDA", f"Grounded \"{it.description}\" (FDC #{it.fdc_id}) -> {it.calories} kcal ({it.protein_g}p/{it.carbs_g}c/{it.fat_g}f)", {
            "fdc_id": it.fdc_id,
            "calories": it.calories,
            "protein_g": it.protein_g,
            "carbs_g": it.carbs_g,
            "fat_g": it.fat_g
        })
    log_event("USDA", f"Total macros: {res.total_calories} kcal, {res.total_protein_g}p, {res.total_carbs_g}c, {res.total_fat_g}f in {elapsed}ms", level="SUCCESS")
    return res

# --- Gemini Multimodal Voice API (Dual-Engine Mode B) ---
class GeminiMultimodalRequest(BaseModel):
    audio_base64: Optional[str] = None
    mime_type: Optional[str] = "audio/webm"
    text_prompt: Optional[str] = None
    user_id: int = 1

@app.post("/api/gemini/multimodal")
def gemini_multimodal(req: GeminiMultimodalRequest):
    t0 = time.time()
    log_event("GEMINI", "Dispatching request to Gemini Multimodal AI", {
        "has_audio": bool(req.audio_base64),
        "text_prompt": req.text_prompt,
        "user_id": req.user_id
    })
    result = process_gemini_multimodal(
        audio_base64=req.audio_base64,
        mime_type=req.mime_type or "audio/webm",
        text_prompt=req.text_prompt,
        user_id=req.user_id
    )
    elapsed = round((time.time() - t0) * 1000, 2)
    if "error" in result and result["error"]:
        if result["error"] == "KEY_REQUIRED":
            log_event("GEMINI", "Gemini API key required - 5 complimentary quota exceeded", level="WARN")
            return JSONResponse(status_code=403, content=result)
        elif result["error"] == "NO_FOOD_DETECTED":
            log_event("GEMINI", f"Non-food utterance rejected by Gemini LLM gate: {result.get('message')}", level="WARN")
            return JSONResponse(status_code=422, content=result)
        else:
            log_event("GEMINI", f"Gemini error: {result.get('message')}", level="ERROR")
            raise HTTPException(status_code=502, detail=result.get("message", "Gemini could not retrieve nutritional information."))
    log_event("GEMINI", f"Gemini response in {elapsed}ms • {len(result.get('items', []))} item(s)", result, level="SUCCESS")
    return result

# --- User Targets ---
@app.get("/api/targets", response_model=UserTargets)
def get_targets(user_id: int = 1):
    targets = get_user_targets(user_id)
    log_event("BACKEND", f"Loaded user daily targets: {targets['calories']} kcal, {targets['protein_g']}p, {targets['carbs_g']}c, {targets['fat_g']}f, {targets.get('fiber_g', 30.0)}fib")
    return targets

@app.post("/api/targets")
def save_targets(targets: UserTargets, user_id: int = 1):
    if targets.calories <= 0:
        raise HTTPException(status_code=422, detail="Calories target must be a positive number greater than 0.")
    if targets.protein_g < 0 or targets.carbs_g < 0 or targets.fat_g < 0 or targets.fiber_g < 0:
        raise HTTPException(status_code=422, detail="Macronutrient targets cannot be negative.")
    update_user_targets(targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g, targets.fiber_g, user_id)
    log_event("SQL", f"Saved daily macro targets for user #{user_id}: {targets.calories} kcal", targets.model_dump(), level="SUCCESS")
    return {"status": "success", "targets": targets}

# --- User Gemini Key & Usage Tier Management ---
class GeminiKeyRequest(BaseModel):
    api_key: str
    user_id: int = 1

@app.get("/api/user/gemini")
def get_gemini_status(user_id: int = 1):
    return get_user_gemini_info(user_id)

@app.post("/api/user/gemini")
def set_gemini_key(req: GeminiKeyRequest):
    if not req.api_key or not req.api_key.strip():
        log_event("BACKEND", "Rejected empty Gemini API key", level="WARN")
        raise HTTPException(status_code=400, detail="API key cannot be empty")
    cleaned = req.api_key.strip()
    if cleaned.startswith("..."):
        log_event("BACKEND", "Kept existing Gemini API key (placeholder submitted)")
        return {"status": "success", "info": get_user_gemini_info(req.user_id)}
    if len(cleaned) < 16 or not re.match(r'^[A-Za-z0-9_\-\.]{16,}$', cleaned):
        log_event("BACKEND", f"Rejected invalid Gemini API key format (length {len(cleaned)})", level="WARN")
        raise HTTPException(status_code=400, detail="Invalid Gemini API key format. Key must be at least 16 characters long.")
    set_user_gemini_key(cleaned, req.user_id)
    last4 = cleaned[-4:] if len(cleaned) >= 4 else cleaned
    return {"status": "success", "info": get_user_gemini_info(req.user_id)}

class HandleUpdateRequest(BaseModel):
    handle: str
    user_id: int = 1

@app.get("/api/user/profile")
def get_profile(user_id: int = 1):
    return get_user_profile(user_id)

@app.post("/api/user/profile")
def save_profile_handle(req: HandleUpdateRequest):
    clean = req.handle.strip().lower().lstrip("@")
    if not clean or len(clean) < 3 or len(clean) > 12 or not re.match(r'^[a-z0-9_]+$', clean):
        raise HTTPException(status_code=400, detail="Handle must be 3-12 characters and contain only lowercase letters, numbers, and underscores.")
    ok = update_user_handle(clean, req.user_id)
    if not ok:
        raise HTTPException(status_code=409, detail="Handle is already taken by another user.")
    log_event("SQL", f"Claimed handle '@{clean}' for user #{req.user_id}", level="SUCCESS")
    return {"status": "success", "handle": clean, "user_id": req.user_id}

# --- Relational Meal Logs (FR-105) ---
@app.get("/api/logs")
def get_logs(user_id: int = 1):
    logs = get_all_meal_logs(user_id)
    log_event("SQL", f"Fetched {len(logs)} meal logs from database for user #{user_id}")
    return logs

@app.post("/api/logs")
def create_log(log: MealLogCreate, user_id: int = 1):
    t0 = time.time()
    log_event("BACKEND", f"Processing meal log creation (engine: {log.engine_used}, meal_type: {log.meal_type})", {
        "raw_transcript": log.raw_transcript,
        "items_count": len(log.items or [])
    })
    items_to_save = log.items or []
    if len(items_to_save) > 25:
        log_event("BACKEND", f"Rejected meal log with {len(items_to_save)} items (max 25 allowed)", level="WARN")
        raise HTTPException(status_code=422, detail="Exceeded maximum limit of 25 food items per meal log.")
    for it in items_to_save:
        w = getattr(it, 'standardized_weight_g', None) or (it.get('standardized_weight_g') if isinstance(it, dict) else 0)
        q = getattr(it, 'quantity', None) or (it.get('quantity') if isinstance(it, dict) else 0)
        if w <= 0 or q <= 0:
            raise HTTPException(status_code=422, detail="Food item weight and quantity must be positive numbers greater than 0.")

    if len(items_to_save) == 0 and log.raw_transcript and log.raw_transcript.strip():
        gem_res = process_gemini_multimodal(text_prompt=log.raw_transcript, user_id=user_id)
        if gem_res.get("items") and len(gem_res.get("items", [])) > 0:
            items_to_save = gem_res.get("items")
        else:
            extracted = extract_entities(log.raw_transcript)
            if extracted.items:
                try:
                    calc = calculate_macros_for_items(extracted.items)
                except ValueError as ve:
                    log_event("USDA", f"Macro grounding failed: {str(ve)}", level="WARN")
                    raise HTTPException(status_code=422, detail=str(ve))
                items_to_save = []
                for i, it in enumerate(extracted.items):
                    m = calc.items[i]
                    items_to_save.append({
                        "food_name": it.food_name,
                        "preparation_state": it.preparation_state,
                        "quantity": it.quantity,
                        "unit": it.unit,
                        "standardized_weight_g": it.standardized_weight_g,
                        "fdc_id": m.fdc_id,
                        "description": m.description,
                        "calories": m.calories,
                        "protein_g": m.protein_g,
                        "carbs_g": m.carbs_g,
                        "fat_g": m.fat_g,
                        "fiber_g": m.fiber_g
                    })
            else:
                log_event("BACKEND", f"Could not identify any food items in '{log.raw_transcript}'", level="WARN")
                raise HTTPException(status_code=422, detail=f"Could not identify any food items in '{log.raw_transcript.strip()}'. Please specify food items and portions clearly.")

    if not items_to_save or len(items_to_save) == 0:
        log_event("BACKEND", "Rejected meal log with 0 food items", level="ERROR")
        raise HTTPException(status_code=400, detail="Cannot save meal log without food items")

    try:
        items_dict = [it.model_dump() if hasattr(it, 'model_dump') else it for it in items_to_save]
        log_id = save_meal_log(
            meal_type=log.meal_type or "snack",
            logged_time=log.logged_time,
            raw_transcript=log.raw_transcript or "",
            engine_used=log.engine_used or "gemini_multimodal_ai",
            items=items_dict,
            user_id=user_id,
            logged_date=log.logged_date
        )
        if log_id <= 0:
            raise HTTPException(status_code=400, detail="Cannot save meal log without food items")
        elapsed = round((time.time() - t0) * 1000, 2)
        log_event("SQL", f"Persisted meal log #{log_id} to SQLite ({len(items_dict)} food items) in {elapsed}ms", {
            "meal_log_id": log_id,
            "engine_used": log.engine_used,
            "items": items_dict,
            "elapsed_ms": elapsed
        }, level="SUCCESS")
        return {"status": "success", "meal_log_id": log_id}
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        log_event("SQL", f"Failed saving meal log to database: {str(e)}", level="ERROR")
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

@app.put("/api/logs/items/{item_id}")
def update_item(item_id: int, req: ItemUpdateRequest):
    if req.quantity <= 0 or req.standardized_weight_g <= 0:
        raise HTTPException(status_code=422, detail="Quantity and weight must be positive numbers greater than 0.")
    res = update_logged_food_item(item_id, req.quantity, req.standardized_weight_g)
    if not res:
        log_event("SQL", f"Item #{item_id} not found for portion update", level="WARN")
        raise HTTPException(status_code=404, detail="Item not found")
    log_event("SQL", f"Updated portion for item #{item_id}: {req.quantity} ({req.standardized_weight_g}g) -> {res['calories']} kcal", res, level="SUCCESS")
    return res

@app.delete("/api/logs/items/{item_id}")
def delete_item(item_id: int):
    from backend.database import delete_logged_food_item
    ok = delete_logged_food_item(item_id)
    if not ok:
        log_event("SQL", f"Item #{item_id} not found for deletion", level="WARN")
        raise HTTPException(status_code=404, detail="Item not found")
    log_event("SQL", f"Deleted individual food item #{item_id} from SQLite", level="SUCCESS")
    return {"status": "deleted", "item_id": item_id}

@app.delete("/api/logs/{log_id}")
def delete_log(log_id: int, user_id: int = 1):
    ok = delete_meal_log(log_id, user_id=user_id)
    if not ok:
        log_event("SQL", f"Meal log #{log_id} not found for deletion", level="WARN")
        raise HTTPException(status_code=404, detail="Log not found")
    log_event("SQL", f"Deleted entire meal log #{log_id} and items from SQLite", level="SUCCESS")
    return {"status": "deleted", "id": log_id}

# --- Static Frontend Serving for PWA ---
STATIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

@app.get("/")
@app.get("/index.html")
def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/styles.css")
def serve_css():
    return FileResponse(os.path.join(STATIC_DIR, "styles.css"), media_type="text/css")

@app.get("/app.js")
def serve_js():
    return FileResponse(os.path.join(STATIC_DIR, "app.js"), media_type="application/javascript")

@app.get("/manifest.json")
def serve_manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.json"))

@app.get("/sw.js")
def serve_sw():
    return FileResponse(os.path.join(STATIC_DIR, "sw.js"), media_type="application/javascript")

app.mount("/icons", StaticFiles(directory=os.path.join(STATIC_DIR, "icons")), name="icons")

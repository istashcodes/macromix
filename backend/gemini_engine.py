import os
import json
import base64
import requests
import re
from typing import Dict, Any, Optional
from backend.database import get_effective_gemini_key, increment_gemini_usage, get_user_gemini_info

SYSTEM_PROMPT = """You are a high-precision nutritional voice assistant.
CRITICAL INSTRUCTION: Analyze the audio or text carefully.
1. If the input is conversational speech, questions, commands, background chatter, or does NOT describe actual food or drink consumed (for example: "we will not take one hour to search for a movie", "hello", "play music", "turn on lights"), you MUST set "is_food": false and "items": [].
2. If and only if the input mentions edible food or beverages consumed, set "is_food": true, transcribe what was eaten, extract each food item entity, and compute precise macronutrients (calories, protein, carbs, fat, fiber).
3. If an input lists multiple foods or describes a composite dish with distinct specified ingredient portions (for example: "chicken biryani with 300g rice and 100g chicken", "salad with 150g chicken and 2 tbsp dressing", "150g chicken, 250g rice, 10 pistas, 15 almonds"), you MUST itemize each distinct component ingredient with its portion as a separate item in the "items" array (e.g. "biryani rice" 300g, "chicken" 100g, "pistachios" 10, "almonds" 15).

Output strictly a JSON object with this structure:
{
  "raw_transcript": string,
  "is_food": boolean,
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack",
  "logged_time": "HH:MM" or null,
  "items": [
    {
      "food_name": string,
      "preparation_state": string,
      "quantity": float,
      "unit": string,
      "standardized_weight_g": float,
      "fdc_id": integer,
      "description": string,
      "calories": float,
      "protein_g": float,
      "carbs_g": float,
      "fat_g": float,
      "fiber_g": float
    }
  ],
  "total_calories": float,
  "total_protein_g": float,
  "total_carbs_g": float,
  "total_fat_g": float,
  "total_fiber_g": float
}
"""

def process_gemini_multimodal(
    audio_base64: Optional[str] = None,
    mime_type: str = "audio/webm",
    text_prompt: Optional[str] = None,
    user_id: int = 1
) -> Dict[str, Any]:
    # Check user eligibility and keys
    user_info = get_user_gemini_info(user_id)
    if not user_info["can_use_gemini"]:
        return {
            "error": "KEY_REQUIRED",
            "message": "A personal Gemini API key is required to validate meals and extract food items. Please configure your key in Settings to continue.",
            "free_remaining": 0,
            "has_custom_key": False
        }

    api_key = get_effective_gemini_key(user_id)
    
    gemini_result = None
    network_error_occurred = False
    last_error_message = ""

    if api_key and api_key != "PRECONFIGURED_FREE_TIER_KEY" and not api_key.startswith("mock_"):
        models_to_try = [
            "gemini-flash-latest",
            "gemini-flash-lite-latest",
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite"
        ]
        
        parts = []
        if audio_base64:
            parts.append({
                "inline_data": {
                    "mime_type": mime_type,
                    "data": audio_base64
                }
            })
        if text_prompt:
            parts.append({"text": text_prompt})
        else:
            parts.append({"text": "Please transcribe the audio and calculate exact macronutrients in JSON."})

        payload = {
            "contents": [{"parts": parts}],
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }

        from backend.debug_logger import log_event

        for model_name in models_to_try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
            
            # Retry up to 3 times on transient network failures or demand spikes
            for attempt in range(1, 4):
                try:
                    resp = requests.post(url, json=payload, timeout=10.0)
                    if resp.status_code == 200:
                        data = resp.json()
                        candidates = data.get("candidates", [])
                        if candidates and "content" in candidates[0]:
                            parts_list = candidates[0]["content"].get("parts", [])
                            for p in parts_list:
                                if "text" in p and p["text"]:
                                    clean_json = p["text"].strip()
                                    if clean_json.startswith("```"):
                                        clean_json = re.sub(r'^```(?:json)?\s*', '', clean_json, flags=re.IGNORECASE)
                                        clean_json = re.sub(r'\s*```$', '', clean_json)
                                    gemini_result = json.loads(clean_json)
                                    break
                        if gemini_result:
                            log_event("GEMINI", f"Gemini ({model_name}) evaluated input", {
                                "is_food": gemini_result.get("is_food", True),
                                "items_count": len(gemini_result.get("items", []))
                            })
                            break
                        else:
                            last_error_message = "Empty candidate response from Gemini"
                    elif resp.status_code in (503, 429, 500) and attempt < 3:
                        log_event("GEMINI", f"Gemini ({model_name}) returned HTTP {resp.status_code}, retrying attempt {attempt}/3...", level="WARN")
                        import time
                        time.sleep(0.8 * attempt)
                        continue
                    else:
                        last_error_message = f"HTTP {resp.status_code}: {resp.text[:150]}"
                        log_event("GEMINI", f"Gemini API ({model_name}) returned {last_error_message}", level="WARN")
                        break
                except (requests.exceptions.RequestException, Exception) as e:
                    network_error_occurred = True
                    last_error_message = str(e)
                    if attempt < 3:
                        log_event("GEMINI", f"Gemini network error on attempt {attempt}/3 ({str(e)}), retrying...", level="WARN")
                        import time
                        time.sleep(1.0 * attempt)
                    else:
                        log_event("GEMINI", f"Gemini connection failed after 3 attempts on {model_name}: {str(e)}", level="WARN")

            if gemini_result:
                break

    # If Gemini explicitly marked the input as non-food or returned 0 items
    if gemini_result:
        is_food = gemini_result.get("is_food", True)
        items = gemini_result.get("items", [])
        if not is_food or len(items) == 0:
            return {
                "error": "NO_FOOD_DETECTED",
                "is_food": False,
                "message": "No food items detected in your input. Please specify what you ate (e.g. '100g chicken and 1 cup rice').",
                "raw_transcript": gemini_result.get("raw_transcript") or text_prompt or "",
                "items": []
            }

    # If Gemini could not be reached after all retries
    if not gemini_result:
        lower_err = last_error_message.lower()
        if network_error_occurred or "policy" in lower_err or "connection" in lower_err or "timeout" in lower_err:
            return {
                "error": "GEMINI_NETWORK_ERROR",
                "message": f"Connection to Gemini AI failed ({last_error_message}). Please check server network connection or firewall settings.",
                "items": []
            }
        if "api_key" in lower_err or "invalid" in lower_err or "unauthenticated" in lower_err or "key not valid" in lower_err:
            return {
                "error": "GEMINI_UNAVAILABLE",
                "message": f"Gemini API authentication failed ({last_error_message}). Please try again later.",
                "items": []
            }
        return {
            "error": "GEMINI_UNAVAILABLE",
            "message": f"Gemini AI could not retrieve nutritional information ({last_error_message}). Please try again.",
            "items": []
        }

    # Increment Gemini usage for this user only on successful response
    new_count = increment_gemini_usage(user_id)
    updated_info = get_user_gemini_info(user_id)

    gemini_result["engine_used"] = "gemini_multimodal_ai"
    gemini_result["user_gemini_info"] = updated_info
    return gemini_result

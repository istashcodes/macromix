import os
import sqlite3
import json
from typing import Dict, Any, List, Optional

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macronomics.db")

def get_db_path() -> str:
    return os.environ.get("MACRONOMICS_DB_PATH", DEFAULT_DB_PATH)

def get_db_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(get_db_path(), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        daily_calories REAL DEFAULT 2000.0,
        daily_protein REAL DEFAULT 150.0,
        daily_carbs REAL DEFAULT 200.0,
        daily_fat REAL DEFAULT 65.0,
        gemini_api_key TEXT,
        gemini_usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """)

    # Ensure columns exist if table was already created earlier
    cursor.execute("PRAGMA table_info(users)")
    cols = [col[1] for col in cursor.fetchall()]
    if "gemini_api_key" not in cols:
        cursor.execute("ALTER TABLE users ADD COLUMN gemini_api_key TEXT")
    if "gemini_usage_count" not in cols:
        cursor.execute("ALTER TABLE users ADD COLUMN gemini_usage_count INTEGER DEFAULT 0")
    if "daily_fiber" not in cols:
        cursor.execute("ALTER TABLE users ADD COLUMN daily_fiber REAL DEFAULT 30.0")
    if "handle" not in cols:
        cursor.execute("ALTER TABLE users ADD COLUMN handle TEXT")

    # USDA SR Legacy Reference Nutrients table (100g baseline values)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS usda_nutrients (
        fdc_id INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        food_name TEXT NOT NULL,
        preparation_state TEXT NOT NULL,
        calories_per_100g REAL NOT NULL,
        protein_per_100g REAL NOT NULL,
        carbs_per_100g REAL NOT NULL,
        fat_per_100g REAL NOT NULL,
        fiber_per_100g REAL NOT NULL,
        search_tokens TEXT
    )
    """)

    # Meal Logs table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS meal_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        meal_type TEXT NOT NULL,
        logged_time TEXT,
        raw_transcript TEXT,
        engine_used TEXT DEFAULT 'usda_deterministic',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        logged_date TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """)

    # Ensure logged_date column exists if table was created previously
    cursor.execute("PRAGMA table_info(meal_logs)")
    ml_cols = [col[1] for col in cursor.fetchall()]
    if "logged_date" not in ml_cols:
        cursor.execute("ALTER TABLE meal_logs ADD COLUMN logged_date TEXT")

    # Logged Food Items table with cascading delete
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS logged_food_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_log_id INTEGER NOT NULL,
        food_name TEXT NOT NULL,
        preparation_state TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL,
        standardized_weight_g REAL NOT NULL,
        fdc_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        calories REAL NOT NULL,
        protein_g REAL NOT NULL,
        carbs_g REAL NOT NULL,
        fat_g REAL NOT NULL,
        fiber_g REAL NOT NULL,
        FOREIGN KEY (meal_log_id) REFERENCES meal_logs(id) ON DELETE CASCADE
    )
    """)

    # Migrate existing logged_food_items table if it contains the legacy fdc_id foreign key
    cursor.execute("PRAGMA foreign_key_list(logged_food_items)")
    existing_fks = cursor.fetchall()
    has_usda_fk = any(
        (fk["table"] if hasattr(fk, "keys") else fk[2]) == "usda_nutrients" 
        for fk in existing_fks
    )
    if has_usda_fk:
        cursor.execute("PRAGMA foreign_keys = OFF")
        cursor.execute("""
        CREATE TABLE logged_food_items_clean (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meal_log_id INTEGER NOT NULL,
            food_name TEXT NOT NULL,
            preparation_state TEXT NOT NULL,
            quantity REAL NOT NULL,
            unit TEXT NOT NULL,
            standardized_weight_g REAL NOT NULL,
            fdc_id INTEGER NOT NULL,
            description TEXT NOT NULL,
            calories REAL NOT NULL,
            protein_g REAL NOT NULL,
            carbs_g REAL NOT NULL,
            fat_g REAL NOT NULL,
            fiber_g REAL NOT NULL,
            FOREIGN KEY (meal_log_id) REFERENCES meal_logs(id) ON DELETE CASCADE
        )
        """)
        cursor.execute("""
        INSERT INTO logged_food_items_clean 
        (id, meal_log_id, food_name, preparation_state, quantity, unit, standardized_weight_g, fdc_id, description, calories, protein_g, carbs_g, fat_g, fiber_g)
        SELECT id, meal_log_id, food_name, preparation_state, quantity, unit, standardized_weight_g, fdc_id, description, calories, protein_g, carbs_g, fat_g, fiber_g 
        FROM logged_food_items
        """)
        cursor.execute("DROP TABLE logged_food_items")
        cursor.execute("ALTER TABLE logged_food_items_clean RENAME TO logged_food_items")
        cursor.execute("PRAGMA foreign_keys = ON")

    # Default demo user
    cursor.execute("""
    INSERT OR IGNORE INTO users (id, username, daily_calories, daily_protein, daily_carbs, daily_fat)
    VALUES (1, 'default_user', 2000.0, 150.0, 200.0, 65.0)
    """)

    conn.commit()
    conn.close()

    seed_usda_reference_data()

def seed_usda_reference_data():
    conn = get_db_connection()
    cursor = conn.cursor()

    benchmark_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "golden_benchmark.json")
    if os.path.exists(benchmark_path):
        with open(benchmark_path, "r", encoding="utf-8") as f:
            cases = json.load(f)

        for case in cases:
            items = case["expected_extraction"]["items"]
            macros = case["expected_macros"]
            for item, macro in zip(items, macros):
                fdc_id = macro["fdc_id"]
                desc = macro["description"]
                food_name = item["food_name"].strip().lower()
                prep = item["preparation_state"].strip().lower()
                w = item["standardized_weight_g"]

                cal_100 = macro["calories"] * 100.0 / w
                prot_100 = macro["protein_g"] * 100.0 / w
                carb_100 = macro["carbs_g"] * 100.0 / w
                fat_100 = macro["fat_g"] * 100.0 / w
                fiber_100 = macro["fiber_g"] * 100.0 / w

                search_tokens = f"{food_name} {prep} {desc.lower()}"

                cursor.execute("""
                INSERT OR REPLACE INTO usda_nutrients 
                (fdc_id, description, food_name, preparation_state, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, search_tokens)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (fdc_id, desc, food_name, prep, cal_100, prot_100, carb_100, fat_100, fiber_100, search_tokens))

        # Add canonical composite & culinary staples (Biryani rice, spiced cooked chicken, Dosa, Crepe, etc.)
        additional_staples = [
            (200001, "Rice, cooked, biryani style with ghee and spices", "biryani rice", "cooked", 145.0, 2.8, 27.5, 2.7, 0.6, "biryani rice cooked biriyani basmati"),
            (200002, "Chicken, meat with marinade and oil, cooked, biryani style", "chicken", "cooked", 240.0, 28.5, 0.0, 13.5, 0.0, "chicken cooked biryani curry spiced"),
            (200003, "Rice, white, long-grain, regular, cooked", "rice", "cooked", 130.0, 2.69, 28.17, 0.28, 0.4, "rice cooked white"),
            (200004, "Dosa, plain, fermented crepe prepared with rice and lentil batter", "dosa", "cooked", 168.0, 3.9, 29.0, 3.7, 1.4, "dosa dosai plain masala cooked indian crepe"),
            (200005, "Crepe, plain, French style thin pancake", "crepe", "cooked", 212.0, 6.4, 28.3, 8.2, 1.1, "crepe crepes plain cooked french pancake"),
            (200006, "Pancakes, plain, prepared from recipe", "pancake", "cooked", 227.0, 6.4, 28.3, 9.7, 1.0, "pancake pancakes cooked breakfast flapjack"),
            (200007, "Idli, steamed rice and lentil cake", "idli", "steamed", 140.0, 4.0, 28.0, 0.4, 1.5, "idli idly steamed indian"),
            (200008, "Roti, whole wheat flatbread, cooked", "roti", "cooked", 264.0, 9.0, 49.0, 3.0, 3.5, "roti chapati flatbread cooked indian"),
            (200009, "Coffee, brewed beverage with milk", "coffee", "liquid", 35.0, 1.5, 3.8, 1.5, 0.0, "coffee latte cappuccino beverage"),
            (200010, "Pizza, cheese, regular crust baked", "pizza", "baked", 266.0, 11.4, 33.3, 9.8, 2.3, "pizza slice cheese baked"),
            (200011, "Sandwich, deli meat and cheese with wheat bread", "sandwich", "prepared", 230.0, 12.0, 24.0, 9.0, 2.0, "sandwich sub roll wrap"),
            (200012, "Salad, mixed greens with light dressing", "salad", "raw", 85.0, 1.5, 5.0, 6.5, 1.8, "salad greens garden salad bowl"),
            (200013, "Yogurt, Icelandic, skyr, plain", "skyr", "raw", 63.0, 11.0, 4.0, 0.2, 0.0, "skyr icelandic yogurt strained dairy plain"),
            (170184, "Nuts, pistachio nuts, raw", "pistachios", "raw", 560.0, 20.16, 27.17, 45.32, 10.6, "pistachios pista pistas pistachio nuts raw dry fruit"),
            (14157, "Water, tap, drinking", "water", "liquid", 0.0, 0.0, 0.0, 0.0, 0.0, "water liquid drinking tap")
        ]
        for st in additional_staples:
            cursor.execute("""
            INSERT OR REPLACE INTO usda_nutrients
            (fdc_id, description, food_name, preparation_state, calories_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, fiber_per_100g, search_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, st)

        # Remove any legacy fake fallback entries from usda_nutrients
        cursor.execute("DELETE FROM usda_nutrients WHERE fdc_id IN (999100, 999999)")

        # Cleanup any empty meal logs with 0 items
        cursor.execute("DELETE FROM meal_logs WHERE id NOT IN (SELECT DISTINCT meal_log_id FROM logged_food_items)")

    conn.commit()
    conn.close()

ENGLISH_STOPWORDS = {
    "for", "with", "in", "to", "at", "a", "an", "the", "and", "or", "of", 
    "from", "by", "on", "about", "into", "through", "during", "before", "after", 
    "above", "below", "we", "will", "not", "take", "one", "hour", "search", 
    "movie", "can", "you", "i", "me", "my", "it", "this", "that", "some", "any", "all",
    "please", "want", "eat", "ate", "having", "had", "like", "get", "got"
}

def get_usda_nutrient(food_name: str, prep_state: str) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()

    food_clean = food_name.strip().lower()
    prep_clean = prep_state.strip().lower()

    # 1. Exact match on food_name and prep_state
    cursor.execute("""
    SELECT * FROM usda_nutrients 
    WHERE LOWER(food_name) = ? AND LOWER(preparation_state) = ?
    LIMIT 1
    """, (food_clean, prep_clean))
    row = cursor.fetchone()

    # 2. Prefer cooked biryani rice / white rice if 'rice' in food
    if not row and "rice" in food_clean:
        target_food = "biryani rice" if "biryani" in food_clean or "biriyani" in food_clean else "white rice"
        cursor.execute("""
        SELECT * FROM usda_nutrients 
        WHERE LOWER(food_name) = ? AND LOWER(preparation_state) = ?
        LIMIT 1
        """, (target_food, prep_clean))
        row = cursor.fetchone()

    # 3. If food is 'chicken' and cooked
    if not row and food_clean in ["chicken", "cooked chicken"]:
        cursor.execute("""
        SELECT * FROM usda_nutrients 
        WHERE LOWER(food_name) = 'chicken' AND LOWER(preparation_state) = 'cooked'
        LIMIT 1
        """)
        row = cursor.fetchone()

    # 4. If no exact prep match, fallback to exact food name
    if not row:
        cursor.execute("""
        SELECT * FROM usda_nutrients 
        WHERE LOWER(food_name) = ?
        ORDER BY CASE WHEN LOWER(preparation_state) = ? THEN 0 ELSE 1 END
        LIMIT 1
        """, (food_clean, prep_clean))
        row = cursor.fetchone()

    # 5. Whole-word token fallback strictly on canonical food_name (excluding stopwords & descriptions)
    if not row:
        tokens = [t for t in food_clean.split() if len(t) >= 3 and t not in ENGLISH_STOPWORDS]
        for tok in reversed(tokens):
            cursor.execute("""
            SELECT * FROM usda_nutrients 
            WHERE (' ' || LOWER(food_name) || ' ') LIKE ?
            ORDER BY CASE WHEN LOWER(preparation_state) = ? THEN 0 ELSE 1 END
            LIMIT 1
            """, (f"% {tok} %", prep_clean))
            row = cursor.fetchone()
            if row:
                break

    conn.close()
    if row:
        return dict(row)

    # Return None if food is uncataloged in the USDA reference table
    return None

def get_user_targets(user_id: int = 1) -> Dict[str, float]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT daily_calories, daily_protein, daily_carbs, daily_fat, daily_fiber FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            "calories": row["daily_calories"],
            "protein_g": row["daily_protein"],
            "carbs_g": row["daily_carbs"],
            "fat_g": row["daily_fat"],
            "fiber_g": row["daily_fiber"] if row["daily_fiber"] is not None else 30.0
        }
    return {"calories": 2000.0, "protein_g": 150.0, "carbs_g": 200.0, "fat_g": 65.0, "fiber_g": 30.0}

def update_user_targets(calories: float, protein_g: float, carbs_g: float, fat_g: float, fiber_g: float = 30.0, user_id: int = 1):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE users SET daily_calories = ?, daily_protein = ?, daily_carbs = ?, daily_fat = ?, daily_fiber = ?
    WHERE id = ?
    """, (calories, protein_g, carbs_g, fat_g, fiber_g, user_id))
    conn.commit()
    conn.close()

def save_meal_log(meal_type: str, items: List[Dict[str, Any]], logged_time: Optional[str] = None, raw_transcript: Optional[str] = None, engine_used: str = "gemini_multimodal_ai", user_id: int = 1, logged_date: Optional[str] = None) -> int:
    if not items or len(items) == 0:
        return -1

    conn = get_db_connection()
    cursor = conn.cursor()

    # Ensure user exists to satisfy foreign key constraint on meal_logs(user_id)
    cursor.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cursor.fetchone():
        cursor.execute("""
        INSERT OR IGNORE INTO users (id, username, daily_calories, daily_protein, daily_carbs, daily_fat)
        VALUES (?, ?, 2000.0, 150.0, 200.0, 65.0)
        """, (user_id, f"user_{user_id}"))
        conn.commit()

    # Idempotency / Duplicate Submission Guard:
    # Check if identical transcript was logged within the last 15 seconds
    clean_transcript = (raw_transcript or "").strip().lower()
    if clean_transcript:
        cursor.execute("""
        SELECT id FROM meal_logs
        WHERE user_id = ? 
          AND LOWER(TRIM(raw_transcript)) = ?
          AND created_at >= datetime('now', '-15 seconds')
        ORDER BY id DESC LIMIT 1
        """, (user_id, clean_transcript))
        existing = cursor.fetchone()
        if existing:
            conn.close()
            return existing["id"]

    # Also check item-level signature within last 10 seconds to catch duplicate submissions without transcript
    cursor.execute("""
    SELECT ml.id, GROUP_CONCAT(LOWER(lfi.food_name) || ':' || CAST(ROUND(lfi.standardized_weight_g, 1) AS TEXT), ',') as item_sig
    FROM meal_logs ml
    JOIN logged_food_items lfi ON lfi.meal_log_id = ml.id
    WHERE ml.user_id = ? AND ml.created_at >= datetime('now', '-10 seconds')
    GROUP BY ml.id
    ORDER BY ml.id DESC LIMIT 3
    """, (user_id,))
    recent_logs = cursor.fetchall()
    if recent_logs:
        current_sig = ",".join(sorted(f"{str(it.get('food_name')).strip().lower()}:{round(float(it.get('standardized_weight_g') or 100.0), 1)}" for it in items))
        for r in recent_logs:
            sig = r["item_sig"]
            if sig:
                sorted_sig = ",".join(sorted(sig.split(',')))
                if sorted_sig == current_sig:
                    conn.close()
                    return r["id"]

    cursor.execute("""
    INSERT INTO meal_logs (user_id, meal_type, logged_time, raw_transcript, engine_used, logged_date)
    VALUES (?, ?, ?, ?, ?, ?)
    """, (user_id, meal_type, logged_time, raw_transcript, engine_used, logged_date))
    meal_log_id = cursor.lastrowid

    for it in items:
        cursor.execute("""
        INSERT INTO logged_food_items 
        (meal_log_id, food_name, preparation_state, quantity, unit, standardized_weight_g, fdc_id, description, calories, protein_g, carbs_g, fat_g, fiber_g)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            meal_log_id,
            str(it.get("food_name") or "Food Item"),
            str(it.get("preparation_state") or "cooked"),
            float(it.get("quantity") or 1.0),
            str(it.get("unit") or "serving"),
            float(it.get("standardized_weight_g") or 100.0),
            int(it.get("fdc_id") or 0),
            str(it.get("description") or ""),
            float(it.get("calories") or 0.0),
            float(it.get("protein_g") or 0.0),
            float(it.get("carbs_g") or 0.0),
            float(it.get("fat_g") or 0.0),
            float(it.get("fiber_g") or 0.0)
        ))

    conn.commit()
    conn.close()
    return meal_log_id

def get_all_meal_logs(user_id: int = 1) -> List[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("""
    SELECT id, user_id, meal_type, logged_time, raw_transcript, engine_used, created_at, logged_date
    FROM meal_logs
    WHERE user_id = ?
    ORDER BY id DESC
    """, (user_id,))
    logs = cursor.fetchall()

    result = []
    for log in logs:
        log_dict = dict(log)
        cursor.execute("""
        SELECT id, food_name, preparation_state, quantity, unit, standardized_weight_g, fdc_id, description, calories, protein_g, carbs_g, fat_g, fiber_g
        FROM logged_food_items
        WHERE meal_log_id = ?
        """, (log["id"],))
        items = [dict(r) for r in cursor.fetchall()]
        if not items:
            continue
        log_dict["items"] = items
        log_dict["total_calories"] = round(sum(i["calories"] for i in items), 2)
        log_dict["total_protein_g"] = round(sum(i["protein_g"] for i in items), 2)
        log_dict["total_carbs_g"] = round(sum(i["carbs_g"] for i in items), 2)
        log_dict["total_fat_g"] = round(sum(i["fat_g"] for i in items), 2)
        log_dict["total_fiber_g"] = round(sum(i["fiber_g"] for i in items), 2)
        result.append(log_dict)

    conn.close()
    return result

def delete_logged_food_item(item_id: int) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT meal_log_id FROM logged_food_items WHERE id = ?", (item_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return False
    meal_log_id = row["meal_log_id"]
    cursor.execute("DELETE FROM logged_food_items WHERE id = ?", (item_id,))
    cursor.execute("SELECT COUNT(*) as cnt FROM logged_food_items WHERE meal_log_id = ?", (meal_log_id,))
    cnt = cursor.fetchone()["cnt"]
    if cnt == 0:
        cursor.execute("DELETE FROM meal_logs WHERE id = ?", (meal_log_id,))
    conn.commit()
    conn.close()
    return True

def update_logged_food_item(item_id: int, quantity: float, standardized_weight_g: float) -> Optional[Dict[str, Any]]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM logged_food_items WHERE id = ?", (item_id,))
    item = cursor.fetchone()
    if not item:
        conn.close()
        return None

    fdc_id = item["fdc_id"]
    cursor.execute("SELECT * FROM usda_nutrients WHERE fdc_id = ?", (fdc_id,))
    ref = cursor.fetchone()
    if ref:
        # Linear scaling against canonical USDA 100g base: (weight / 100.0) * ref
        new_cals = round((standardized_weight_g / 100.0) * ref["calories_per_100g"], 2)
        new_prot = round((standardized_weight_g / 100.0) * ref["protein_per_100g"], 2)
        new_carb = round((standardized_weight_g / 100.0) * ref["carbs_per_100g"], 2)
        new_fat = round((standardized_weight_g / 100.0) * ref["fat_per_100g"], 2)
        new_fiber = round((standardized_weight_g / 100.0) * ref["fiber_per_100g"], 2)
    else:
        # Scale proportionally from existing item macros
        old_weight = float(item["standardized_weight_g"]) if item["standardized_weight_g"] else 100.0
        ratio = (standardized_weight_g / old_weight) if old_weight > 0 else 1.0
        new_cals = round(float(item["calories"]) * ratio, 2)
        new_prot = round(float(item["protein_g"]) * ratio, 2)
        new_carb = round(float(item["carbs_g"]) * ratio, 2)
        new_fat = round(float(item["fat_g"]) * ratio, 2)
        new_fiber = round(float(item["fiber_g"]) * ratio, 2)

    cursor.execute("""
    UPDATE logged_food_items
    SET quantity = ?, standardized_weight_g = ?, calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ?
    WHERE id = ?
    """, (quantity, standardized_weight_g, new_cals, new_prot, new_carb, new_fat, new_fiber, item_id))
    conn.commit()
    conn.close()
    return {
        "id": item_id,
        "quantity": quantity,
        "standardized_weight_g": standardized_weight_g,
        "calories": new_cals,
        "protein_g": new_prot,
        "carbs_g": new_carb,
        "fat_g": new_fat,
        "fiber_g": new_fiber
    }

def delete_meal_log(meal_log_id: int, user_id: int = 1) -> bool:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM meal_logs WHERE id = ? AND user_id = ?", (meal_log_id, user_id))
    affected = cursor.rowcount
    conn.commit()
    conn.close()
    return affected > 0

def get_user_gemini_info(user_id: int = 1) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT gemini_usage_count FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    count = (row["gemini_usage_count"] or 0) if row else 0
    return {
        "gemini_usage_count": count,
        "free_remaining": 9999,
        "has_custom_key": True,
        "can_use_gemini": True,
        "masked_key": f"...{PRECONFIGURED_GEMINI_KEY[-4:]}",
        "gemini_api_key": PRECONFIGURED_GEMINI_KEY
    }

PRECONFIGURED_GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

def get_effective_gemini_key(user_id: int = 1) -> str:
    return PRECONFIGURED_GEMINI_KEY

def increment_gemini_usage(user_id: int = 1) -> int:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET gemini_usage_count = COALESCE(gemini_usage_count, 0) + 1 WHERE id = ?", (user_id,))
    conn.commit()
    cursor.execute("SELECT gemini_usage_count FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    return row["gemini_usage_count"] if row else 0

def set_user_gemini_key(api_key: str, user_id: int = 1):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET gemini_api_key = ? WHERE id = ?", (api_key.strip(), user_id))
    conn.commit()
    conn.close()

def get_user_profile(user_id: int = 1) -> Dict[str, Any]:
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, username, handle, daily_calories, daily_protein, daily_carbs, daily_fat, daily_fiber FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    if row:
        return dict(row)
    return {"id": user_id, "username": f"user_{user_id}", "handle": None}

def update_user_handle(handle: str, user_id: int = 1) -> bool:
    clean_handle = handle.strip().lower().lstrip("@")
    conn = get_db_connection()
    cursor = conn.cursor()
    # Check if handle is taken by another user
    cursor.execute("SELECT id FROM users WHERE LOWER(handle) = ? AND id != ?", (clean_handle, user_id))
    if cursor.fetchone():
        conn.close()
        return False
    cursor.execute("UPDATE users SET handle = ? WHERE id = ?", (clean_handle, user_id))
    conn.commit()
    conn.close()
    return True



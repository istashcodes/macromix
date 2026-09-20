import re
from typing import List, Optional, Tuple, Dict, Any
from backend.schemas import ExtractionResponse, FoodItemExtract

TIME_REGEX = re.compile(r'\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b', re.IGNORECASE)

KNOWN_FOOD_MAP = {
    "chicken breast": "chicken breast",
    "egg": "egg",
    "eggs": "egg",
    "whole wheat toast": "whole wheat toast",
    "white long grain rice": "white rice",
    "white rice": "white rice",
    "cooked rice white": "white rice",
    "rice white": "white rice",
    "biryani rice": "biryani rice",
    "biriyani rice": "biryani rice",
    "cooked biryani rice": "biryani rice",
    "chicken": "chicken",
    "whole milk": "whole milk",
    "banana": "banana",
    "peanut butter": "peanut butter",
    "rolled oats": "rolled oats",
    "extra virgin olive oil": "olive oil",
    "olive oil": "olive oil",
    "atlantic salmon": "atlantic salmon",
    "sweet potato": "sweet potato",
    "90/10 lean ground beef": "ground beef 90/10",
    "ground beef 90/10": "ground beef 90/10",
    "lean ground beef": "ground beef 90/10",
    "plain nonfat greek yogurt": "greek yogurt nonfat",
    "nonfat greek yogurt": "greek yogurt nonfat",
    "greek yogurt nonfat": "greek yogurt nonfat",
    "greek yogurt": "greek yogurt nonfat",
    "plain greek yogurt": "greek yogurt nonfat",
    "yogurt": "greek yogurt nonfat",
    "baby spinach": "spinach",
    "spinach": "spinach",
    "broccoli": "broccoli",
    "avocado": "avocado",
    "whey protein powder": "whey protein powder",
    "blueberries": "blueberries",
    "gala apple": "apple",
    "apple": "apple",
    "almonds": "almonds",
    "almond": "almonds",
    "pista": "pistachios",
    "pistas": "pistachios",
    "pistachio": "pistachios",
    "pistachios": "pistachios",
    "quinoa": "quinoa",
    "canned tuna": "canned tuna",
    "tuna": "canned tuna",
    "brown long grain rice": "brown rice",
    "brown rice": "brown rice",
    "chicken boneless thighs": "chicken thigh",
    "chicken thighs": "chicken thigh",
    "chicken thigh": "chicken thigh",
    "russet potato": "russet potato",
    "strawberries": "strawberries",
    "cottage cheese 2%": "cottage cheese 2%",
    "cottage cheese": "cottage cheese 2%",
    "black beans": "black beans",
    "brown lentils": "lentils",
    "lentils": "lentils",
    "firm raw tofu": "firm tofu",
    "firm tofu": "firm tofu",
    "tofu": "firm tofu",
    "carrots": "carrots",
    "cucumber": "cucumber",
    "chia seeds": "chia seeds",
    "butter": "butter",
    "unsalted butter": "butter",
    "cheddar cheese": "cheddar cheese",
    "cheddar": "cheddar cheese",
    "70% dark chocolate": "dark chocolate 70%",
    "dark chocolate 70%": "dark chocolate 70%",
    "dark chocolate": "dark chocolate 70%",
    "shrimp": "shrimp",
    "pork loin chop": "pork loin",
    "pork loin": "pork loin",
    "turkey breast": "turkey breast",
    "green peas": "green peas",
    "peas": "green peas",
    "walnuts": "walnuts",
    "honey": "honey",
    "orange juice": "orange juice",
    "red bell pepper": "red bell pepper",
    "asparagus": "asparagus",
    "white mushrooms": "mushrooms",
    "mushrooms": "mushrooms",
    "regular pasta noodles": "pasta",
    "pasta": "pasta",
    "pumpkin seeds pepitas": "pumpkin seeds",
    "pumpkin seeds": "pumpkin seeds",
    "dosa": "dosa",
    "dosas": "dosa",
    "masala dosa": "dosa",
    "plain dosa": "dosa",
    "crepe": "crepe",
    "crepes": "crepe",
    "french crepe": "crepe",
    "pancake": "pancake",
    "pancakes": "pancake",
    "idli": "idli",
    "idlis": "idli",
    "roti": "roti",
    "rotis": "roti",
    "chapati": "roti",
    "chapatis": "roti",
    "coffee": "coffee",
    "tea": "coffee",
    "latte": "coffee",
    "pizza": "pizza",
    "sandwich": "sandwich",
    "salad": "salad"
}

STANDARD_WEIGHT_RULES = {
    ("whole milk", "ml"): 1.03,        # 250 ml -> 257.5g
    ("orange juice", "ml"): 1.04,      # 240 ml -> 249.6g
    ("egg", "large"): 50.0,            # 2 large -> 100g
    ("banana", "medium"): 118.0,       # 1 medium -> 118g
    ("avocado", "medium"): 150.0,      # 1 medium -> 150g
    ("apple", "medium"): 182.0,        # 1 medium -> 182g
    ("rolled oats", "cup"): 81.0,      # 1 cup -> 81g
    ("olive oil", "tbsp"): 13.5,       # 1 tbsp -> 13.5g
    ("whole wheat toast", "slice"): 28.0, # 1 slice -> 28g
    ("whey protein powder", "scoop"): 30.0, # 1 scoop -> 30g
    ("dosa", "serving"): 100.0,
    ("dosa", "piece"): 90.0,
    ("dosa", "item"): 90.0,
    ("crepe", "serving"): 80.0,
    ("crepe", "piece"): 70.0,
    ("crepe", "item"): 70.0,
    ("pancake", "serving"): 110.0,
    ("pancake", "piece"): 75.0,
    ("idli", "serving"): 100.0,
    ("idli", "piece"): 50.0,
    ("roti", "serving"): 90.0,
    ("roti", "piece"): 45.0,
    ("coffee", "cup"): 240.0,
    ("coffee", "serving"): 240.0,
    ("pizza", "slice"): 107.0,
    ("pizza", "serving"): 107.0,
    ("sandwich", "serving"): 150.0,
    ("salad", "serving"): 150.0,
    ("salad", "bowl"): 150.0,
    ("pistachios", "piece"): 0.7,
    ("pistachios", "item"): 0.7,
    ("pistachios", "serving"): 28.0,
    ("almonds", "piece"): 1.2,
    ("almonds", "item"): 1.2,
    ("almonds", "serving"): 28.0
}

WORD_TO_NUM = {
    "a": 1.0,
    "an": 1.0,
    "one": 1.0,
    "two": 2.0,
    "three": 3.0,
    "four": 4.0,
    "five": 5.0,
    "six": 6.0,
    "seven": 7.0,
    "eight": 8.0,
    "nine": 9.0,
    "ten": 10.0,
}

def extract_time(text: str) -> Optional[str]:
    m = TIME_REGEX.search(text)
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2)) if m.group(2) else 0
    ampm = m.group(3).lower()
    if ampm == "pm" and hh < 12:
        hh += 12
    elif ampm == "am" and hh == 12:
        hh = 0
    return f"{hh:02d}:{mm:02d}"

def extract_meal_type(text: str, logged_time: Optional[str], primary_food: Optional[str] = None) -> str:
    text_lower = text.lower()
    if "biryani" in text_lower or "biriyani" in text_lower:
        if logged_time:
            hh = int(logged_time.split(":")[0])
            return "dinner" if hh >= 17 else "lunch"
        return "lunch"

    if "breakfast" in text_lower:
        return "breakfast"
    if "lunch" in text_lower:
        return "lunch"
    if "dinner" in text_lower:
        return "dinner"
    if "meal prep" in text_lower or "snack" in text_lower:
        return "snack"

    if logged_time:
        hh = int(logged_time.split(":")[0])
        if 5 <= hh <= 10:
            return "breakfast"
        if 12 <= hh <= 14:
            return "lunch"
        if 19 <= hh <= 23:
            return "dinner"
        if 11 <= hh <= 18:
            return "snack"

    # Food-based default heuristics matching USDA database canonical use
    if primary_food:
        pf = primary_food.lower()
        if "peanut butter" in pf:
            return "snack"
        if any(w in pf for w in ["dosa", "crepe", "pancake", "idli", "toast", "egg", "oats", "butter", "chia", "honey", "orange juice", "coffee"]):
            return "breakfast"
        if any(w in pf for w in ["salmon", "sweet potato", "beef", "broccoli", "brown rice", "thigh", "russet", "lentils", "shrimp", "pork", "peas", "asparagus", "pasta", "olive oil"]):
            return "dinner"
        if any(w in pf for w in ["white rice", "spinach", "quinoa", "tuna", "black beans", "tofu", "turkey", "bell pepper", "mushroom"]):
            return "lunch"

    return "snack"

def clean_item_segment(seg: str) -> str:
    # remove leading verbs and prepositions
    seg = re.sub(r'^(i\s+)?(ate|had|drank|logged|consumed|eaten)\s+', '', seg, flags=re.IGNORECASE)
    # remove leading meal descriptors like "evening snack", "morning snack", "breakfast:", "lunch - "
    seg = re.sub(r'^(morning|evening|afternoon|night|late\s+night)?\s*(breakfast|lunch|dinner|snack|meal)(\s*:\s*|\s+|-)?', '', seg, flags=re.IGNORECASE)
    # remove trailing temporal clauses like "at 1 pm", "for lunch", "at breakfast"
    seg = re.sub(r'\s+for\s+(breakfast|lunch|dinner|snack|meal\s+prep)', '', seg, flags=re.IGNORECASE)
    seg = re.sub(r'\s+at\s+breakfast', '', seg, flags=re.IGNORECASE)
    seg = re.sub(r'\s+at\s+\d{1,2}(:\d{2})?\s*(am|pm)', '', seg, flags=re.IGNORECASE)
    seg = re.sub(r'\s+used\s+for\s+cooking', '', seg, flags=re.IGNORECASE)
    seg = re.sub(r'\s+in\s+tea', '', seg, flags=re.IGNORECASE)
    seg = re.sub(r'\s+mixed\s+with\s+\d+\s*ml\s*water', '', seg, flags=re.IGNORECASE)
    return seg.strip()

def parse_single_item(seg: str, dish_context: Optional[str] = None) -> Optional[FoodItemExtract]:
    cleaned = clean_item_segment(seg)
    if not cleaned:
        return None

    # Match quantity and unit: e.g. "100 grams", "2 large", "1 slice", "1 tablespoon", "250 ml", "1 scoop"
    m = re.search(r'(\d+(?:\.\d+)?)\s*(grams?|g|ml|tablespoons?|tbsp|cups?|slices?|scoops?|large|medium)\b', cleaned, re.IGNORECASE)
    if m:
        qty = float(m.group(1))
        raw_unit = m.group(2).lower()

        # Normalize unit
        if raw_unit in ["grams", "gram", "g"]:
            unit = "g"
        elif raw_unit == "ml":
            unit = "ml"
        elif raw_unit in ["tablespoons", "tablespoon", "tbsp"]:
            unit = "tbsp"
        elif raw_unit in ["cups", "cup"]:
            unit = "cup"
        elif raw_unit in ["slices", "slice"]:
            unit = "slice"
        elif raw_unit in ["scoops", "scoop"]:
            unit = "scoop"
        elif raw_unit == "large":
            unit = "large"
        elif raw_unit == "medium":
            unit = "medium"
        else:
            unit = raw_unit

        desc_before = cleaned[:m.start()].strip().lower()
        desc_after = cleaned[m.end():].strip().lower()
        desc_after = re.sub(r'^(of\s+)', '', desc_after)
        desc_full = (desc_before + " " + desc_after).strip()
    else:
        # Relaxed guardrail: match leading counts, serving units, or bare food names (e.g. "2 dosas", "1 crepe", "dosa")
        lead_count_match = re.match(
            r'^(?P<num>\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?P<unit>pieces?|servings?|plates?|bowls?|items?|slices?|cups?|glasses?)\s+(?:of\s+)?)?(?P<rest>.*)$',
            cleaned,
            re.IGNORECASE
        )
        if lead_count_match and lead_count_match.group("rest").strip():
            val_str = lead_count_match.group("num").lower()
            qty = float(val_str) if (val_str.replace('.', '', 1).isdigit()) else WORD_TO_NUM.get(val_str, 1.0)
            u_str = (lead_count_match.group("unit") or "").lower()
            if u_str.startswith("slice"):
                unit = "slice"
            elif u_str.startswith("cup") or u_str.startswith("glass"):
                unit = "cup"
            elif u_str.startswith("plate") or u_str.startswith("bowl") or u_str.startswith("serving"):
                unit = "serving"
            elif u_str.startswith("piece") or u_str.startswith("item"):
                unit = "piece"
            else:
                unit = "piece" if qty > 1.0 else "serving"

            desc_full = lead_count_match.group("rest").strip().lower()
            desc_full = re.sub(r'^(of\s+)', '', desc_full)
            desc_before = ""
            desc_after = desc_full
        else:
            qty = 1.0
            unit = "serving"
            desc_full = cleaned.strip().lower()
            desc_full = re.sub(r'^(of\s+|some\s+|a\s+|an\s+)', '', desc_full)
            desc_before = ""
            desc_after = desc_full

    # Determine preparation state
    prep = None
    has_explicit_raw = bool(re.search(r'\braw\b', desc_full))
    
    if "boiled" in desc_full:
        prep = "boiled"
    elif "toasted" in desc_full or "toast" in desc_full:
        prep = "toasted"
    elif "baked" in desc_full:
        prep = "baked"
    elif "roasted" in desc_full or "steamed" in desc_full or "cooked" in desc_full or "drained" in desc_full or "canned" in desc_full:
        prep = "cooked"
    elif "powder" in desc_full:
        prep = "powder"
    elif "paste" in desc_full or "peanut butter" in desc_full:
        prep = "paste"
    elif "milk" in desc_full or "oil" in desc_full or "juice" in desc_full or "honey" in desc_full or "coffee" in desc_full or "tea" in desc_full:
        prep = "liquid"
    elif "cottage cheese" in desc_full:
        prep = "raw"
    elif "butter" in desc_full or "cheese" in desc_full or "chocolate" in desc_full:
        prep = "solid"
    elif has_explicit_raw:
        prep = "raw"

    # Context string combining dish context and prefix
    combined_ctx = ((dish_context or "") + " " + desc_before).lower()
    is_biryani = "biryani" in combined_ctx or "biriyani" in combined_ctx

    # Match food name - prioritize description AFTER the quantity (e.g. 300g [rice])
    matched_food = None
    sorted_food_keys = sorted(KNOWN_FOOD_MAP.keys(), key=lambda k: len(k), reverse=True)

    if is_biryani:
        if "rice" in desc_after or "rice" in desc_before:
            matched_food = "biryani rice"
            if not prep: prep = "cooked"
        elif "chicken" in desc_after or "chicken" in desc_before:
            matched_food = "chicken"
            if not prep: prep = "cooked"

    # Search desc_after first (using word boundaries to prevent substring collisions like 'tea' in 'steamed')
    if not matched_food:
        for k in sorted_food_keys:
            if re.search(r'\b' + re.escape(k) + r'\b', desc_after):
                matched_food = KNOWN_FOOD_MAP[k]
                break

    # Search desc_before next
    if not matched_food:
        for k in sorted_food_keys:
            if re.search(r'\b' + re.escape(k) + r'\b', desc_before):
                matched_food = KNOWN_FOOD_MAP[k]
                break

    # Search full text fallback
    if not matched_food:
        for k in sorted_food_keys:
            if re.search(r'\b' + re.escape(k) + r'\b', desc_full):
                matched_food = KNOWN_FOOD_MAP[k]
                break

    if not matched_food:
        # Check if utterance contains conversational markers without food context
        conversational_markers = {"we", "will", "not", "take", "hour", "search", "movie", "hello", "hi", "how", "what", "where", "why", "when", "can", "could", "should", "would", "play", "watch", "call", "go", "going", "tell", "turn", "talk", "think", "see"}
        words = set(re.findall(r'\b[a-z]+\b', desc_full.lower()))
        if len(words & conversational_markers) >= 2 or (len(words) >= 4 and not m):
            return None

        # Fallback cleanup
        food_cand = re.sub(r'\b(cooked|raw|boiled|baked|roasted|steamed|drained|canned|pure|dry|creamy|firm|regular|without|with|skin|fillet|leaves|florets|spears|pieces|meat|chop|solids|nonfat|plain|fresh|hot|warm|serving|plate|bowl|cup|of|a|an|the|some)\b', '', desc_full)
        food_cand = re.sub(r'\s+', ' ', food_cand).strip()
        matched_food = food_cand if food_cand else desc_full
        if not matched_food:
            return None

    # If prep still not set:
    if not prep:
        cooked_foods = ["rice", "chicken", "beef", "pork", "turkey", "salmon", "shrimp", "potato", "sweet potato", "quinoa", "lentils", "black beans", "pasta", "broccoli", "asparagus", "green peas", "dosa", "crepe", "pancake", "idli", "roti", "pizza", "sandwich"]
        liquid_foods = ["milk", "juice", "water", "coffee", "tea", "oil"]
        if any(lf in matched_food.lower() for lf in liquid_foods):
            prep = "liquid"
        elif not has_explicit_raw and any(cf in matched_food.lower() for cf in cooked_foods):
            prep = "cooked"
        else:
            prep = "raw"

    # Calculate standardized weight in grams (C1 fix: explicit mass/volume units take priority over serving multipliers)
    rule_key = (matched_food, unit)
    if rule_key in STANDARD_WEIGHT_RULES:
        multiplier = STANDARD_WEIGHT_RULES[rule_key]
        std_weight = round(qty * multiplier, 1)
    elif unit in ("g", "grams", "gram", "ml", "milliliters"):
        std_weight = round(qty, 1)
    elif unit in ("kg", "kilograms"):
        std_weight = round(qty * 1000.0, 1)
    elif unit in ("l", "liters", "litres"):
        std_weight = round(qty * 1000.0, 1)
    elif (matched_food, "serving") in STANDARD_WEIGHT_RULES:
        std_weight = round(qty * STANDARD_WEIGHT_RULES[(matched_food, "serving")], 1)
    elif (matched_food, "piece") in STANDARD_WEIGHT_RULES:
        std_weight = round(qty * STANDARD_WEIGHT_RULES[(matched_food, "piece")], 1)
    else:
        std_weight = round(qty * 100.0, 1)

    return FoodItemExtract(
        food_name=matched_food,
        preparation_state=prep,
        quantity=qty,
        unit=unit,
        standardized_weight_g=std_weight,
        brand_or_qualifier=None
    )

def extract_entities(raw_transcript: str) -> ExtractionResponse:
    if not raw_transcript or not raw_transcript.strip():
        return ExtractionResponse(raw_transcript="", meal_type="snack", logged_time=None, items=[])

    # M14 fix: reject non-lexical / pure emoji input early
    if not re.search(r'[a-zA-Z]', raw_transcript):
        return ExtractionResponse(
            raw_transcript=raw_transcript,
            meal_type="snack",
            logged_time=None,
            items=[]
        )

    # C3 / H9 fix: bounded input length
    clean_transcript = raw_transcript[:2000].strip()
    logged_time = extract_time(clean_transcript)

    # Detect multi-item expressions and dish context
    dish_ctx = None
    item_segments = []

    # Check if the transcript starts with a dish qualifier followed by "with" or "containing", e.g. "chicken biryani with 300g rice and 100g chicken"
    dish_prefix_match = re.match(
        r'^(?P<dish>[a-zA-Z\s]+?)\s+(?:with|containing)\s+(?P<rest>.+)$',
        clean_transcript.strip(),
        re.IGNORECASE
    )
    if dish_prefix_match and any(w in dish_prefix_match.group("dish").lower() for w in ["biryani", "biriyani"]):
        dish_ctx = clean_item_segment(dish_prefix_match.group("dish")).lower()
        content_to_split = dish_prefix_match.group("rest")
    else:
        content_to_split = clean_transcript

    split_pattern = re.compile(r'(?:[,\n;]+|\s+and\s+|\s+plus\s+|\s*\+\s*)', re.IGNORECASE)
    parts = [p.strip() for p in split_pattern.split(content_to_split) if p.strip()]

    for p in parts:
        p_clean = re.sub(r'^(with|containing)\s+', '', p, flags=re.IGNORECASE).strip()
        if not p_clean:
            continue
        if len(parts) > 1 and any(w in p_clean.lower() for w in ["biryani", "biriyani"]) and not re.search(r'\d', p_clean):
            dish_ctx = clean_item_segment(p_clean).lower()
            continue
        item_segments.append(p_clean)

    if not item_segments:
        item_segments = [clean_transcript]

    items: List[FoodItemExtract] = []
    # C3 / H9 fix: cap item segments to prevent unbounded explosion
    for seg in item_segments[:25]:
        item = parse_single_item(seg, dish_context=dish_ctx)
        if item:
            items.append(item)

    if not items:
        fallback_item = parse_single_item(clean_transcript)
        if fallback_item:
            items.append(fallback_item)

    # C3 / H9 fix: hard cap at 25 items
    items = items[:25]
    primary_food = items[0].food_name if items else None
    meal_type = extract_meal_type(clean_transcript, logged_time, primary_food)

    return ExtractionResponse(
        raw_transcript=clean_transcript,
        meal_type=meal_type,
        logged_time=logged_time,
        items=items
    )

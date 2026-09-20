from typing import List
from backend.schemas import FoodItemExtract, MacroItem, MacroCalculationResponse
from backend.database import get_usda_nutrient

def calculate_macros_for_items(items: List[FoodItemExtract]) -> MacroCalculationResponse:
    macro_items: List[MacroItem] = []
    total_cal = 0.0
    total_prot = 0.0
    total_carb = 0.0
    total_fat = 0.0
    total_fiber = 0.0

    for item in items:
        usda_row = get_usda_nutrient(item.food_name, item.preparation_state)
        if not usda_row:
            prep_str = f" ({item.preparation_state})" if item.preparation_state else ""
            raise ValueError(
                f"Nutritional data for '{item.food_name}'{prep_str} was not found in the USDA reference database. Try switching to the Gemini AI engine for open-vocabulary food recognition."
            )

        fdc_id = usda_row["fdc_id"]
        desc = usda_row["description"]
        cal_100 = usda_row["calories_per_100g"]
        prot_100 = usda_row["protein_per_100g"]
        carb_100 = usda_row["carbs_per_100g"]
        fat_100 = usda_row["fat_per_100g"]
        fiber_100 = usda_row["fiber_per_100g"]

        w = item.standardized_weight_g
        factor = w / 100.0

        # Zero-Hallucination linear proportion formula:
        cal = round(factor * cal_100, 2)
        prot = round(factor * prot_100, 2)
        carb = round(factor * carb_100, 2)
        fat = round(factor * fat_100, 2)
        fiber = round(factor * fiber_100, 2)

        macro_items.append(MacroItem(
            fdc_id=fdc_id,
            description=desc,
            calories=cal,
            protein_g=prot,
            carbs_g=carb,
            fat_g=fat,
            fiber_g=fiber
        ))

        total_cal += cal
        total_prot += prot
        total_carb += carb
        total_fat += fat
        total_fiber += fiber

    return MacroCalculationResponse(
        items=macro_items,
        total_calories=round(total_cal, 2),
        total_protein_g=round(total_prot, 2),
        total_carbs_g=round(total_carb, 2),
        total_fat_g=round(total_fat, 2),
        total_fiber_g=round(total_fiber, 2)
    )

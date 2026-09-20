import argparse
import json
import sys
import os
from typing import List, Dict, Any

# Ensure parent path is in python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.schemas import ExtractionResponse, FoodItemExtract
from backend.nlp_extractor import extract_entities
from backend.macro_engine import calculate_macros_for_items
from backend.database import init_db

def run_benchmark(benchmark_path: str) -> bool:
    print("=" * 70)
    print("      'macronomics' AUTONOMOUS QUALITY GATES VERIFICATION HARNESS     ")
    print("=" * 70)

    if not os.path.exists(benchmark_path):
        print(f"ERROR: Benchmark file not found at: {benchmark_path}")
        return False

    with open(benchmark_path, "r", encoding="utf-8") as f:
        bench_cases: List[Dict[str, Any]] = json.load(f)

    # Initialize SQLite and USDA seed
    init_db()

    total_cases = len(bench_cases)
    schema_valid_count = 0
    total_entities = 0
    correct_entities = 0
    total_macro_items = 0
    correct_macro_items = 0

    discrepancies = []

    for case in bench_cases:
        cid = case["id"]
        transcript = case["transcript"]
        exp_ext = case["expected_extraction"]
        exp_macros = case["expected_macros"]

        # --- 1. Schema Integrity Verification ---
        try:
            res: ExtractionResponse = extract_entities(transcript)
            # Re-validate via Pydantic model serialization
            serialized = res.model_dump()
            ExtractionResponse(**serialized)
            schema_valid_count += 1
            schema_ok = True
        except Exception as e:
            schema_ok = False
            discrepancies.append(f"Case {cid} Schema Error: {e}")

        # --- 2. Entity Precision Verification ---
        case_entity_ok = True
        if len(res.items) != len(exp_ext["items"]):
            case_entity_ok = False
            discrepancies.append(f"Case {cid} Item Count Mismatch: got {len(res.items)}, expected {len(exp_ext['items'])}")
        else:
            for r_it, e_it in zip(res.items, exp_ext["items"]):
                total_entities += 1
                food_match = (r_it.food_name.strip().lower() == e_it["food_name"].strip().lower())
                prep_match = (r_it.preparation_state.strip().lower() == e_it["preparation_state"].strip().lower())
                qty_match = (r_it.quantity == e_it["quantity"])
                unit_match = (r_it.unit.strip().lower() == e_it["unit"].strip().lower())
                weight_match = (abs(r_it.standardized_weight_g - e_it["standardized_weight_g"]) <= 0.5)

                if food_match and prep_match and qty_match and unit_match and weight_match:
                    correct_entities += 1
                else:
                    case_entity_ok = False
                    discrepancies.append(
                        f"Case {cid} Entity Discrepancy:\n"
                        f"  Got: {r_it.food_name} ({r_it.preparation_state}, {r_it.quantity} {r_it.unit}, {r_it.standardized_weight_g}g)\n"
                        f"  Exp: {e_it['food_name']} ({e_it['preparation_state']}, {e_it['quantity']} {e_it['unit']}, {e_it['standardized_weight_g']}g)"
                    )

        # Also verify meal_type and logged_time
        if res.meal_type != exp_ext["meal_type"]:
            discrepancies.append(f"Case {cid} Meal Type Discrepancy: got '{res.meal_type}', expected '{exp_ext['meal_type']}'")
        if res.logged_time != exp_ext["logged_time"]:
            discrepancies.append(f"Case {cid} Time Discrepancy: got '{res.logged_time}', expected '{exp_ext['logged_time']}'")

        # --- 3. Deterministic Macro Accuracy Verification ---
        calc = calculate_macros_for_items(res.items)
        if len(calc.items) != len(exp_macros):
            discrepancies.append(f"Case {cid} Macro Count Mismatch: got {len(calc.items)}, expected {len(exp_macros)}")
        else:
            for r_m, e_m in zip(calc.items, exp_macros):
                total_macro_items += 1
                d_cal = abs(r_m.calories - e_m["calories"])
                d_prot = abs(r_m.protein_g - e_m["protein_g"])
                d_carb = abs(r_m.carbs_g - e_m["carbs_g"])
                d_fat = abs(r_m.fat_g - e_m["fat_g"])
                d_fib = abs(r_m.fiber_g - e_m["fiber_g"])

                # Criteria: |Δ Cal| <= 2kcal, |Δ Macro| <= 0.5g, and exact FDC ID
                if (d_cal <= 2.0 and d_prot <= 0.5 and d_carb <= 0.5 and d_fat <= 0.5 and d_fib <= 0.5 and r_m.fdc_id == e_m["fdc_id"]):
                    correct_macro_items += 1
                else:
                    discrepancies.append(
                        f"Case {cid} Macro Math Discrepancy (FDC {r_m.fdc_id} vs {e_m['fdc_id']}):\n"
                        f"  Got: Cal={r_m.calories}, P={r_m.protein_g}, C={r_m.carbs_g}, F={r_m.fat_g}, Fib={r_m.fiber_g}\n"
                        f"  Exp: Cal={e_m['calories']}, P={e_m['protein_g']}, C={e_m['carbs_g']}, F={e_m['fat_g']}, Fib={e_m['fiber_g']}\n"
                        f"  Deltas: ΔCal={d_cal:.2f}, ΔP={d_prot:.2f}, ΔC={d_carb:.2f}, ΔF={d_fat:.2f}, ΔFib={d_fib:.2f}"
                    )

    schema_rate = (schema_valid_count / total_cases) * 100.0 if total_cases > 0 else 0.0
    entity_rate = (correct_entities / total_entities) * 100.0 if total_entities > 0 else 0.0
    macro_rate = (correct_macro_items / total_macro_items) * 100.0 if total_macro_items > 0 else 0.0

    print("\n" + "-" * 70)
    print("QUALITY GATES EVALUATION METRICS:")
    print("-" * 70)
    print(f"1. Schema Integrity: {schema_rate:6.2f}%  (Target: 100.0%) -> {'[ PASS ]' if schema_rate >= 100.0 else '[ FAIL ]'}")
    print(f"2. Entity Precision: {entity_rate:6.2f}%  (Target: >= 99.0%) -> {'[ PASS ]' if entity_rate >= 99.0 else '[ FAIL ]'}")
    print(f"3. Macro Accuracy:   {macro_rate:6.2f}%  (Target: >= 99.5%) -> {'[ PASS ]' if macro_rate >= 99.5 else '[ FAIL ]'}")
    print("-" * 70)

    if discrepancies:
        print(f"\n[!] Detected {len(discrepancies)} Discrepancies:")
        for d in discrepancies[:10]:
            print(f"  - {d}")
        if len(discrepancies) > 10:
            print(f"  ... and {len(discrepancies) - 10} more.")

    passed_all = (schema_rate >= 100.0 and entity_rate >= 99.0 and macro_rate >= 99.5)
    if passed_all:
        print("\n>>> ALL QUALITY GATES PASSED: BUILD APPROVED FOR ZERO-HALLUCINATION FOOD LOGGING! <<<")
    else:
        print("\n>>> VERIFICATION FAILED: QUALITY GATES NOT MET! <<<")

    return passed_all

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run macronomics golden benchmark evaluation harness.")
    parser.add_argument("--benchmark", type=str, default="golden_benchmark.json", help="Path to golden benchmark JSON file")
    args = parser.parse_args()

    success = run_benchmark(args.benchmark)
    sys.exit(0 if success else 1)

import time
import pytest
from playwright.sync_api import sync_playwright

BASE_URL = "http://localhost:8000"

def test_portion_edit_recalculates_macros():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        page.goto(BASE_URL)
        page.wait_for_timeout(1000)

        # 1. Setup user and a meal with 2 eggs (12g protein, 140 kcal, 1g carbs, 10g fat, 100g)
        page.evaluate("""() => {
            localStorage.setItem('macromix_user_handle', 'istashmacros');
            const onb = document.getElementById('onboarding-screen');
            if (onb) onb.classList.add('hidden');

            const today = (typeof window.getTodayDateString === 'function') ? window.getTodayDateString() : '2026-11-15';
            const testMeal = {
                id: 10001,
                owner_handle: 'istashmacros',
                meal_type: 'breakfast',
                logged_date: today,
                created_at: new Date().toISOString(),
                logged_time: '08:30',
                raw_transcript: '2 eggs',
                total_calories: 140,
                total_protein_g: 12,
                total_carbs_g: 1,
                total_fiber_g: 0,
                total_fat_g: 10,
                items: [
                    {
                        id: 20001,
                        food_name: 'Boiled Eggs',
                        quantity: 2,
                        unit: 'eggs',
                        standardized_weight_g: 100,
                        calories: 140,
                        protein_g: 12,
                        carbs_g: 1,
                        fiber_g: 0,
                        fat_g: 10
                    }
                ]
            };

            const key = 'macronomics_meals_istashmacros';
            localStorage.setItem(key, JSON.stringify([testMeal]));
            if (typeof window.setCurrentLogs === 'function') {
                window.setCurrentLogs([testMeal]);
            }
            if (typeof window.filterAndRenderSelectedDate === 'function') {
                window.filterAndRenderSelectedDate();
            }
        }""")

        page.wait_for_timeout(500)

        # 2. Check initial rendered item in timeline
        prot_chip = page.locator("#item-20001 .macro-chip.prot").inner_text()
        cal_chip = page.locator("#item-20001 .macro-chip.cal").inner_text()
        assert "12p" in prot_chip, f"Expected 12p initially, got {prot_chip}"
        assert "140" in cal_chip, f"Expected 140 kcal initially, got {cal_chip}"

        # 3. Click the edit button for the item
        page.click("#item-20001 .edit-item-btn")
        page.wait_for_timeout(300)

        modal = page.locator("#edit-item-modal")
        assert modal.is_visible(), "Edit item modal should be visible"

        qty_input = page.locator("#edit-quantity")
        weight_input = page.locator("#edit-weight-g")
        preview_prot = page.locator("#edit-preview-prot")
        preview_cal = page.locator("#edit-preview-cal")

        assert qty_input.input_value() == "2", "Initial quantity should be 2"
        assert weight_input.input_value() == "100", "Initial weight should be 100"
        assert "12" in preview_prot.inner_text(), f"Preview protein should show 12, got {preview_prot.inner_text()}"

        # 4. User changes quantity from 2 to 4
        qty_input.fill("4")
        page.wait_for_timeout(200)

        # Weight should automatically update to 200g
        assert weight_input.input_value() == "200", f"Weight should auto-scale to 200, got {weight_input.input_value()}"
        # Live preview should show 24g protein and 280 kcal
        assert "24" in preview_prot.inner_text(), f"Preview protein should be 24g, got {preview_prot.inner_text()}"
        assert "280" in preview_cal.inner_text(), f"Preview calories should be 280, got {preview_cal.inner_text()}"

        # 5. Click 'Update my macromix'
        page.click("#btn-save-item-edit")
        page.wait_for_timeout(500)

        assert not modal.is_visible(), "Modal should close after saving"

        # 6. Verify item in timeline is updated: 2 -> 4 eggs, 12p -> 24p, 140 -> 280 kcal
        updated_sub = page.locator("#item-20001 .meal-item-sub").inner_text()
        updated_prot = page.locator("#item-20001 .macro-chip.prot").inner_text()
        updated_cal = page.locator("#item-20001 .macro-chip.cal").inner_text()
        updated_fat = page.locator("#item-20001 .macro-chip.fat").inner_text()

        print(f"Updated item: sub='{updated_sub}', prot='{updated_prot}', cal='{updated_cal}', fat='{updated_fat}'")

        assert "4" in updated_sub, f"Subtext should show 4 eggs, got '{updated_sub}'"
        assert "24p" in updated_prot, f"Protein chip MUST show 24p, got '{updated_prot}'"
        assert "280" in updated_cal, f"Calorie chip MUST show 280 kcal, got '{updated_cal}'"
        assert "20fat" in updated_fat, f"Fat chip MUST show 20fat, got '{updated_fat}'"

        # 7. Verify localStorage reflects the recalculation
        stored_item = page.evaluate("""() => {
            const meals = JSON.parse(localStorage.getItem('macronomics_meals_istashmacros'));
            return meals[0].items[0];
        }""")
        assert stored_item["quantity"] == 4, f"Stored quantity should be 4, got {stored_item['quantity']}"
        assert stored_item["protein_g"] == 24, f"Stored protein should be 24, got {stored_item['protein_g']}"
        assert stored_item["calories"] == 280, f"Stored calories should be 280, got {stored_item['calories']}"
        assert stored_item["standardized_weight_g"] == 200, f"Stored weight should be 200, got {stored_item['standardized_weight_g']}"

        # 8. Test subsequent re-edit: user edits from 4 back to 3
        page.click("#item-20001 .edit-item-btn")
        page.wait_for_timeout(300)
        assert qty_input.input_value() == "4"

        qty_input.fill("3")
        page.wait_for_timeout(200)
        assert weight_input.input_value() == "150"
        assert "18" in preview_prot.inner_text(), f"Preview protein should show 18g, got {preview_prot.inner_text()}"

        page.click("#btn-save-item-edit")
        page.wait_for_timeout(500)

        re_updated_prot = page.locator("#item-20001 .macro-chip.prot").inner_text()
        assert "18p" in re_updated_prot, f"Protein chip should show 18p for 3 eggs, got '{re_updated_prot}'"

        # 9. Test weight-based editing with Enter key submission:
        # Add Chicken Breast 100g (31g protein, 165 kcal)
        page.evaluate("""() => {
            const today = (typeof window.getTodayDateString === 'function') ? window.getTodayDateString() : '2026-11-15';
            const chickenMeal = {
                id: 10002,
                owner_handle: 'istashmacros',
                meal_type: 'lunch',
                logged_date: today,
                created_at: new Date().toISOString(),
                logged_time: '13:00',
                raw_transcript: '100g chicken breast',
                total_calories: 165,
                total_protein_g: 31,
                total_carbs_g: 0,
                total_fiber_g: 0,
                total_fat_g: 3.6,
                items: [
                    {
                        id: 20002,
                        food_name: 'Grilled Chicken Breast',
                        quantity: 100,
                        unit: 'g',
                        standardized_weight_g: 100,
                        calories: 165,
                        protein_g: 31,
                        carbs_g: 0,
                        fiber_g: 0,
                        fat_g: 3.6
                    }
                ]
            };
            const current = (typeof window.getCurrentLogs === 'function') ? window.getCurrentLogs() : [];
            const updated = [...current, chickenMeal];
            const key = 'macronomics_meals_istashmacros';
            localStorage.setItem(key, JSON.stringify(updated));
            if (typeof window.setCurrentLogs === 'function') {
                window.setCurrentLogs(updated);
            }
            if (typeof window.filterAndRenderSelectedDate === 'function') {
                window.filterAndRenderSelectedDate();
            }
        }""")
        page.wait_for_timeout(500)

        # Edit chicken breast weight directly from 100 to 200
        page.click("#item-20002 .edit-item-btn")
        page.wait_for_timeout(300)
        assert weight_input.input_value() == "100"

        weight_input.fill("200")
        page.wait_for_timeout(200)

        # Quantity should auto-update to 200
        assert qty_input.input_value() == "200"
        # Preview protein should show 62g protein
        assert "62" in preview_prot.inner_text(), f"Preview protein should be 62g, got {preview_prot.inner_text()}"

        # Submit via Enter key on the weight input
        weight_input.press("Enter")
        page.wait_for_timeout(500)

        assert not modal.is_visible(), "Modal should close on Enter key submission"

        chicken_prot = page.locator("#item-20002 .macro-chip.prot").inner_text()
        chicken_cal = page.locator("#item-20002 .macro-chip.cal").inner_text()
        assert "62p" in chicken_prot, f"Expected 62p for 200g chicken, got '{chicken_prot}'"
        assert "330" in chicken_cal, f"Expected 330 kcal for 200g chicken, got '{chicken_cal}'"

        # Take screenshot of the updated timeline
        page.screenshot(path='/Users/satish.s/.gemini/antigravity/brain/1b29da82-03ee-4adf-ba27-814141ad0f77/portion_edit_recalculated_verified.png')

        browser.close()

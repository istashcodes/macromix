from typing import List, Optional
from pydantic import BaseModel, Field

class FoodItemExtract(BaseModel):
    food_name: str = Field(..., description="Canonical culinary food name")
    preparation_state: str = Field(..., description="Preparation state (cooked, raw, boiled, toasted, etc.)")
    quantity: float = Field(..., gt=0, le=10000, description="Numerical quantity extracted from voice/text")
    unit: str = Field(..., description="Unit of measure (g, ml, large, medium, slice, cup, tbsp, scoop)")
    standardized_weight_g: float = Field(..., gt=0, le=10000, description="Standardized weight in grams")
    brand_or_qualifier: Optional[str] = Field(None, description="Optional brand or qualifier")

class ExtractionResponse(BaseModel):
    raw_transcript: str = Field(..., max_length=2000, description="Raw user input audio transcript or text")
    meal_type: str = Field(..., description="Meal type: breakfast, lunch, dinner, snack")
    logged_time: Optional[str] = Field(None, description="Time in HH:MM 24h format, or null")
    items: List[FoodItemExtract] = Field(default_factory=list, description="Extracted food items")

class ExtractRequest(BaseModel):
    raw_transcript: str = Field(..., max_length=2000)

class MacroItem(BaseModel):
    fdc_id: int
    description: str
    calories: float = Field(..., ge=0, le=50000)
    protein_g: float = Field(..., ge=0, le=5000)
    carbs_g: float = Field(..., ge=0, le=5000)
    fat_g: float = Field(..., ge=0, le=5000)
    fiber_g: float = Field(..., ge=0, le=5000)

class MacroCalculationRequest(BaseModel):
    items: List[FoodItemExtract]

class MacroCalculationResponse(BaseModel):
    items: List[MacroItem]
    total_calories: float = Field(..., ge=0, le=100000)
    total_protein_g: float = Field(..., ge=0, le=10000)
    total_carbs_g: float = Field(..., ge=0, le=10000)
    total_fat_g: float = Field(..., ge=0, le=10000)
    total_fiber_g: float = Field(..., ge=0, le=10000)

class MealLogItemRecord(BaseModel):
    id: Optional[int] = None
    food_name: str
    preparation_state: Optional[str] = "cooked"
    quantity: float = Field(1.0, gt=0, le=10000)
    unit: Optional[str] = "serving"
    standardized_weight_g: float = Field(100.0, gt=0, le=10000)
    fdc_id: Optional[int] = 0
    description: Optional[str] = ""
    calories: float = Field(0.0, ge=0, le=50000)
    protein_g: float = Field(0.0, ge=0, le=5000)
    carbs_g: float = Field(0.0, ge=0, le=5000)
    fat_g: float = Field(0.0, ge=0, le=5000)
    fiber_g: Optional[float] = Field(0.0, ge=0, le=5000)

class MealLogCreate(BaseModel):
    meal_type: Optional[str] = "snack"
    logged_time: Optional[str] = None
    raw_transcript: Optional[str] = Field("", max_length=2000)
    engine_used: Optional[str] = "usda_deterministic"
    logged_date: Optional[str] = None
    items: Optional[List[MealLogItemRecord]] = Field(default_factory=list)

class MealLogResponse(BaseModel):
    id: int
    user_id: int
    meal_type: str
    logged_time: Optional[str] = None
    raw_transcript: Optional[str] = ""
    engine_used: str = "usda_deterministic"
    created_at: str
    logged_date: Optional[str] = None
    items: List[MealLogItemRecord]
    total_calories: float
    total_protein_g: float
    total_carbs_g: float
    total_fat_g: float
    total_fiber_g: float

class UserTargets(BaseModel):
    calories: float = Field(2000.0, gt=0, le=20000)
    protein_g: float = Field(150.0, ge=0, le=1000)
    carbs_g: float = Field(200.0, ge=0, le=2000)
    fat_g: float = Field(65.0, ge=0, le=1000)
    fiber_g: float = Field(30.0, ge=0, le=500)

class ItemUpdateRequest(BaseModel):
    quantity: float = Field(..., gt=0, le=10000)
    standardized_weight_g: float = Field(..., gt=0, le=10000)

import { ExerciseType } from "./api";

export const PRIMARY_MUSCLES = [
  "Chest",
  "Back",
  "Shoulders",
  "Biceps",
  "Triceps",
  "Legs",
  "Glutes",
  "Core",
  "Cardio",
  "Other",
] as const;

/**
 * Fallback vocabulary for the exercise form's Equipment picker.
 *
 * The picker normally offers the names in the equipment catalog — that is what
 * `exercises.equipment` references, and renaming an item propagates into it (see
 * EquipmentController::update). This list stands in only while the catalog is
 * empty or unreachable, so a fresh install still has something to pick from.
 */
export const EQUIPMENT_OPTIONS = [
  "Barbell",
  "Dumbbell",
  "Machine",
  "Cable",
  "Body Weight",
  "Band",
  "Kettlebell",
  "Plate",
  "None",
  "Other",
] as const;

export const EXERCISE_TYPES: { value: ExerciseType; label: string }[] = [
  { value: "weight_reps",       label: "Weight + Reps" },
  { value: "reps_only",         label: "Reps Only" },
  { value: "duration",          label: "Duration" },
  { value: "distance_duration", label: "Distance + Duration" },
];

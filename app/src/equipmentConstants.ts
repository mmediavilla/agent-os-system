import { EquipmentStatus } from "./api";

/**
 * Categories offered in the equipment form.
 *
 * A UI convention, not a database constraint — the API validates
 * `equipment_type` as a free string, so this list can grow without a migration
 * and rows created before an entry was added keep working.
 */
export const EQUIPMENT_TYPES = [
  "Free Weight",
  "Machine",
  "Cable",
  "Bodyweight",
  "Cardio",
  "Band",
  "Accessory",
  "Other",
] as const;

/**
 * Closed set — the API rejects anything else, so keep this in sync with
 * EquipmentController::STATUSES.
 */
export const EQUIPMENT_STATUSES: { value: EquipmentStatus; label: string }[] = [
  { value: "active",   label: "Active" },
  { value: "broken",   label: "Broken" },
  { value: "wishlist", label: "Wishlist" },
];

export function equipmentStatusLabel(status: EquipmentStatus): string {
  return EQUIPMENT_STATUSES.find((s) => s.value === status)?.label ?? status;
}

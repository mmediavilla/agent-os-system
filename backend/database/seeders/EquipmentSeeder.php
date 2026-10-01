<?php

namespace Database\Seeders;

use App\Models\Equipment;
use Illuminate\Database\Seeder;

/**
 * Seeds the equipment catalog from database/data/equipment.json.
 *
 * The list lives in JSON rather than inline in this class because it is also
 * the payload source for populating an already-running instance over the API —
 * keeping it in one file stops the seeded catalog and the live one from
 * drifting apart.
 *
 * Rows are matched on [user_id, name], the table's unique key, so re-running
 * this refreshes type/status/notes instead of colliding. Photos are untouched:
 * image_path is not in the payload, so a seeded row that later got a photo
 * keeps it.
 */
class EquipmentSeeder extends Seeder
{
    public function run(): void
    {
        $path = database_path('data/equipment.json');

        $items = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

        foreach ($items as $item) {
            Equipment::updateOrCreate(
                // Single-user phase: the catalog is unowned, matching how
                // EquipmentController::ownerId() resolves with no authenticated
                // user. Becomes the seeded user's id when auth lands.
                ['user_id' => null, 'name' => $item['name']],
                [
                    'equipment_type' => $item['equipment_type'],
                    'status' => $item['status'],
                    'notes' => $item['notes'],
                ],
            );
        }

        $this->command?->info('Seeded '.count($items).' equipment items.');
    }
}

<?php

namespace App\Services\Diagnostics;

use InvalidArgumentException;

/**
 * One thing a check found: what it looked at, how bad it is, what it saw, and
 * what to do about it.
 *
 * **Evidence is carried whatever the severity.** A passing check with nothing
 * to show would take numbers off the Stats page — journal mode, latency, a
 * heartbeat's age — that nothing else draws any more.
 *
 * **A finding offers a soft fix or a manual step, never both.** `fix` is a key
 * Troubleshoot may run; `manual` is the sentence naming what the owner has to
 * do. An `ok` finding offers neither.
 */
final class Finding
{
    /**
     * @param  list<string>  $evidence
     */
    public function __construct(
        public readonly string $key,
        public readonly string $group,
        public readonly string $title,
        public readonly Severity $severity,
        public readonly string $detail,
        public readonly array $evidence = [],
        public readonly ?SoftFix $fix = null,
        public readonly ?string $manual = null,
    ) {
        if ($fix !== null && $manual !== null) {
            throw new InvalidArgumentException("{$key} offers a soft fix and a manual step; pick one.");
        }

        if ($severity === Severity::Ok && ($fix !== null || $manual !== null)) {
            throw new InvalidArgumentException("{$key} passed and still offers something to do.");
        }
    }

    /**
     * @return array{key: string, group: string, title: string, severity: string, detail: string, evidence: list<string>, fix: array{key: string, label: string}|null, manual: string|null}
     */
    public function toArray(): array
    {
        return [
            'key' => $this->key,
            'group' => $this->group,
            'title' => $this->title,
            'severity' => $this->severity->value,
            'detail' => $this->detail,
            'evidence' => array_values($this->evidence),
            'fix' => $this->fix === null ? null : ['key' => $this->fix->value, 'label' => $this->fix->label()],
            'manual' => $this->manual,
        ];
    }

    /**
     * Back from a stored report. A fix key the enum no longer holds is dropped
     * rather than thrown on — the set is append-only, but a hand-edited row
     * should cost that one line, not the page.
     *
     * @param  array<string, mixed>  $data
     */
    public static function fromArray(array $data): self
    {
        $fix = $data['fix']['key'] ?? null;

        return new self(
            key: (string) $data['key'],
            group: (string) $data['group'],
            title: (string) $data['title'],
            severity: Severity::tryFrom((string) $data['severity']) ?? Severity::Problem,
            detail: (string) $data['detail'],
            evidence: array_values(array_map('strval', $data['evidence'] ?? [])),
            fix: is_string($fix) ? SoftFix::tryFrom($fix) : null,
            manual: isset($data['manual']) ? (string) $data['manual'] : null,
        );
    }
}

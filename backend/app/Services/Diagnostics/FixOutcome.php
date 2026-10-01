<?php

namespace App\Services\Diagnostics;

/**
 * What one soft fix did when Troubleshoot ran it: done, failed, or skipped —
 * and one sentence saying so.
 *
 * **Every fix the owner confirmed gets an outcome**, including the ones that
 * did not run: a fix the fresh checks no longer asked for is `skipped` with the
 * reason, never silently dropped, or the report would disagree with the dialog.
 */
final class FixOutcome
{
    public const DONE = 'done';

    public const FAILED = 'failed';

    public const SKIPPED = 'skipped';

    public const STATUSES = [self::DONE, self::FAILED, self::SKIPPED];

    public function __construct(
        public readonly SoftFix $fix,
        public readonly string $status,
        public readonly string $detail,
    ) {}

    /**
     * @return array{key: string, label: string, status: string, detail: string}
     */
    public function toArray(): array
    {
        return [
            'key' => $this->fix->value,
            'label' => $this->fix->label(),
            'status' => $this->status,
            'detail' => $this->detail,
        ];
    }

    /**
     * Back from a stored report; a key the enum no longer holds is dropped by
     * the caller, `Finding::fromArray`'s rule.
     *
     * @param  array<string, mixed>  $data
     */
    public static function fromArray(array $data): ?self
    {
        $fix = SoftFix::tryFrom((string) ($data['key'] ?? ''));

        if ($fix === null) {
            return null;
        }

        $status = (string) ($data['status'] ?? '');

        return new self($fix, in_array($status, self::STATUSES, true) ? $status : self::FAILED, (string) ($data['detail'] ?? ''));
    }
}

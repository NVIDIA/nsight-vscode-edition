/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useLayoutEffect, useMemo, useState } from 'react';
import type { Warp, WarpSnapshot } from '../../model';

type ExpandedWarp = { device: number; stopId?: string; identity: string | null };

/** Retain visible expansions only while their GPU and logical warp identity still match. */
export function useWarpExpansion(
    snapshot: WarpSnapshot | null,
    visible: readonly Warp[],
    stopId: string | undefined,
    deviceId: number | undefined
): { expanded: ReadonlyMap<string, ExpandedWarp>; toggle: (warp: Warp) => void } {
    const [saved, setExpanded] = useState(new Map<string, ExpandedWarp>());
    const knownDevice = deviceId ?? snapshot?.device.id;
    // Resolve surviving expansions before rendering and deciding whether to follow CUDA focus.
    const expanded = useMemo(() => {
        const kept = new Map(
            [...saved].filter(([id, previous]) => {
                if (knownDevice !== undefined && previous.device !== knownDevice) return false;
                // Keep identities while running/loading, then validate the next snapshot.
                if (!snapshot) return true;
                const warp = visible.find((row) => `${row.sm}:${row.warp}` === id);
                return (
                    warp &&
                    (previous.stopId === stopId ||
                        (previous.identity !== null && previous.identity === warpIdentity(warp)))
                );
            })
        );
        return kept.size === saved.size ? saved : kept;
    }, [saved, snapshot, visible, stopId, knownDevice]);
    useLayoutEffect(() => {
        if (expanded !== saved) setExpanded(expanded);
    }, [expanded, saved]);

    function toggle(warp: Warp): void {
        if (!snapshot) return;
        const id = `${warp.sm}:${warp.warp}`;
        setExpanded((previous) => {
            const next = new Map(previous);
            if (next.has(id)) next.delete(id);
            else next.set(id, { device: snapshot.device.id, stopId, identity: warpIdentity(warp) });
            return next;
        });
    }

    return { expanded, toggle };
}

/** A grid identifies the kernel launch; block coordinates disambiguate reused physical slots. */
function warpIdentity(warp: Warp): string | null {
    return warp.gridId !== null && warp.block !== null
        ? JSON.stringify([warp.gridId, warp.block])
        : null;
}

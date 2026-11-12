/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useState, type HTMLAttributes } from 'react';
import type { Warp } from '../../model';
import { isLaneFocusable } from '../../presentation';

/** One Tab stop per strip/subtable; arrow keys move only keyboard focus. */
export function useLaneNavigation(
    warp: Warp,
    focusedLane: number | null,
    axis: 'horizontal' | 'vertical'
): (lane: number) => HTMLAttributes<HTMLButtonElement> {
    const [tabLane, setTabLane] = useState(focusedLane);
    const eligible = (warp.lanes ?? [])
        .map((lane) => lane.id)
        .filter((id) => isLaneFocusable(warp, id))
        .sort((a, b) => a - b);
    const current =
        tabLane !== null && eligible.includes(tabLane)
            ? tabLane
            : focusedLane !== null && eligible.includes(focusedLane)
              ? focusedLane
              : eligible[0];
    return (lane) => ({
        tabIndex: lane === current ? 0 : -1,
        onFocus: () => setTabLane(lane),
        onKeyDown: (event) => {
            const backward = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
            const forward = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
            if (event.key !== backward && event.key !== forward) return;
            event.preventDefault();
            event.stopPropagation();
            const next =
                eligible[
                    Math.max(
                        0,
                        Math.min(
                            eligible.length - 1,
                            eligible.indexOf(lane) + (event.key === forward ? 1 : -1)
                        )
                    )
                ];
            event.currentTarget
                .closest('[data-lane-group]')
                ?.querySelector<HTMLButtonElement>(`[data-lane-id="${next}"]`)
                ?.focus();
        }
    });
}

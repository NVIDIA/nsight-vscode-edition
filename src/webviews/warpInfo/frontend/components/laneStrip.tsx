/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { ReactElement } from 'react';
import type { Warp } from '../../model';
import { isLaneFocusable, laneAppearance } from '../../presentation';
import { useLaneNavigation } from '../hooks/useLaneNavigation';

export function FocusArrow(): ReactElement {
    return (
        <svg className="focus-arrow" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 3 H5 V1 L9 5 L5 9 V7 H1 Z" />
        </svg>
    );
}

export function LaneStrip({
    warp,
    focusedLane,
    pendingLane,
    blocked,
    onFocusLane
}: {
    warp: Warp;
    focusedLane: number | null;
    pendingLane?: number;
    blocked?: boolean;
    onFocusLane?: (lane: number) => void;
}): ReactElement {
    const navigation = useLaneNavigation(warp, focusedLane, 'horizontal');
    return (
        <div
            className="lane-strip"
            role="group"
            data-lane-group
            aria-label={`Lanes for warp ${warp.warp}, SM ${warp.sm}`}
        >
            {Array.from({ length: 32 }, (_, id) => {
                const appearance = laneAppearance(warp, id);
                const focused = id === focusedLane;
                const label = `Lane ${id}: ${appearance.text}${focused ? '; CUDA focus' : ''}`;
                const content = focused ? <FocusArrow /> : null;
                return onFocusLane && isLaneFocusable(warp, id) ? (
                    <button
                        key={id}
                        type="button"
                        data-lane-id={id}
                        {...navigation(id)}
                        className={`lane lane-control lane-${appearance.state}${pendingLane === id ? ' lane-pending' : ''}`}
                        aria-label={`${label}; Focus on this lane`}
                        aria-disabled={blocked}
                        aria-busy={pendingLane === id}
                        onClick={() => {
                            if (!blocked) onFocusLane(id);
                        }}
                    >
                        {content}
                    </button>
                ) : (
                    <span
                        key={id}
                        className={`lane lane-${appearance.state}`}
                        role="img"
                        aria-label={label}
                    >
                        {content}
                    </span>
                );
            })}
        </div>
    );
}

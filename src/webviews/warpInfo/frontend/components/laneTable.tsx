/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { ReactElement } from 'react';
import type { Warp } from '../../model';
import { isLaneFocusable, laneAppearance } from '../../presentation';
import { FocusArrow } from './laneStrip';
import { useLaneNavigation } from '../hooks/useLaneNavigation';

const HEADERS = [
    ['Lane', 'Hardware lane number within the warp (0–31).'],
    ['Status', 'Lane participation state and any reported assertion or exception.'],
    ['Thread', 'Thread coordinates (x, y, z) within the block.'],
    ['PC', 'This lane’s program counter (instruction address).'],
    ['Exception', 'Reported fault details. The report may apply to an entire warp or device.']
] as const;

export function LaneTable({
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
    const navigation = useLaneNavigation(warp, focusedLane, 'vertical');
    if (warp.lanes === null)
        return (
            <p className="lane-detail-message">Lane data unavailable. Use Retry above the table.</p>
        );
    if (warp.lanes.length === 0) return <p className="lane-detail-message">No lanes reported.</p>;
    return (
        <div
            className="lane-table-scroll"
            role="region"
            tabIndex={
                warp.lanes.some(
                    (lane) => lane.exception || (onFocusLane && isLaneFocusable(warp, lane.id))
                )
                    ? undefined
                    : 0
            }
            aria-label={`Lane details for warp ${warp.warp}, SM ${warp.sm}; scroll horizontally for more columns`}
        >
            <table
                className="lane-table"
                aria-label={`Lane details for warp ${warp.warp}, SM ${warp.sm}`}
            >
                <thead>
                    <tr>
                        {HEADERS.map(([label, tooltip]) => (
                            <th
                                key={label}
                                scope="col"
                                data-tooltip={tooltip}
                                aria-description={tooltip}
                            >
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody data-lane-group>
                    {[...warp.lanes]
                        .sort((a, b) => a.id - b.id)
                        .map((lane) => {
                            const appearance = laneAppearance(warp, lane.id);
                            const focused = lane.id === focusedLane;
                            return (
                                <tr
                                    key={lane.id}
                                    data-lane-row={lane.id}
                                    className={focused ? 'cuda-focused-row' : undefined}
                                >
                                    <td className="mono">
                                        <span className="lane-id">
                                            {focused && <FocusArrow />}
                                            {onFocusLane && isLaneFocusable(warp, lane.id) ? (
                                                <button
                                                    type="button"
                                                    className={`lane-link${pendingLane === lane.id ? ' lane-pending' : ''}`}
                                                    data-lane-id={lane.id}
                                                    {...navigation(lane.id)}
                                                    data-tooltip="Focus on this lane"
                                                    aria-label={`Lane ${lane.id}${focused ? ', CUDA focus' : ''}: Focus on this lane`}
                                                    aria-disabled={blocked}
                                                    aria-busy={pendingLane === lane.id}
                                                    onClick={() => {
                                                        if (!blocked) onFocusLane(lane.id);
                                                    }}
                                                >
                                                    {lane.id}
                                                </button>
                                            ) : (
                                                lane.id
                                            )}
                                        </span>
                                    </td>
                                    <td>
                                        <span
                                            className={`lane lane-status-dot lane-${appearance.state}`}
                                            aria-hidden="true"
                                        />
                                        {appearance.text}
                                    </td>
                                    <td className="mono">
                                        {lane.thread ? `(${lane.thread.join(', ')})` : 'N/A'}
                                    </td>
                                    <td className="mono">{lane.pc ?? 'N/A'}</td>
                                    <td className="lane-exception-text">
                                        <span
                                            className="exception-value full-text-value"
                                            tabIndex={lane.exception ? 0 : undefined}
                                            data-tooltip={lane.exception ?? undefined}
                                            aria-label={lane.exception ?? undefined}
                                        >
                                            <span className="truncated-text">
                                                {lane.exception ?? 'None reported'}
                                            </span>
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                </tbody>
            </table>
        </div>
    );
}

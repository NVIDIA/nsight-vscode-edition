/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import type { ReactElement } from 'react';
import type { FocusTarget, Warp, WarpSnapshot } from '../../model';
import { overviewText } from '../../presentation';
import { PC_HELP } from '../warpTable';
import { FocusArrow, LaneStrip } from './laneStrip';
import { LaneTable } from './laneTable';

/** A measured warp row and its optional lane subtable share one virtualized group. */
export function WarpRowGroup({
    warp,
    device,
    stopId,
    focus,
    pendingFocus,
    focusBlocked,
    onFocusLane,
    open,
    onToggle,
    virtualIndex,
    rowIndex,
    measureElement
}: {
    warp: Warp;
    device: number;
    stopId?: string;
    focus: WarpSnapshot['focus'];
    pendingFocus?: FocusTarget;
    focusBlocked?: boolean;
    onFocusLane?: (target: FocusTarget) => void;
    open: boolean;
    onToggle: () => void;
    virtualIndex: number;
    rowIndex: number;
    measureElement: (element: HTMLTableSectionElement | null) => void;
}): ReactElement {
    const text = overviewText(warp);
    const focused = focus?.sm === warp.sm && focus.warp === warp.warp;
    const id = `${warp.sm}:${warp.warp}`;
    const pendingLane =
        pendingFocus?.sm === warp.sm && pendingFocus.warp === warp.warp
            ? pendingFocus.lane
            : undefined;
    const focusLane = onFocusLane
        ? (lane: number): void => onFocusLane({ sm: warp.sm, warp: warp.warp, lane })
        : undefined;
    const detailId = `lanes-${device}-${warp.sm}-${warp.warp}`;
    return (
        <tbody className="warp-group" data-index={virtualIndex} ref={measureElement}>
            <tr
                className={`warp-row${focused ? ' cuda-focused-row' : ''}`}
                data-warp-key={id}
                aria-rowindex={rowIndex}
            >
                <td>
                    <button
                        className="expand-warp"
                        type="button"
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={`${open ? 'Collapse' : 'Expand'} warp ${warp.warp}, SM ${warp.sm}`}
                        onClick={onToggle}
                    >
                        <svg viewBox="0 0 10 10" aria-hidden="true">
                            <path d="M3 1 L7 5 L3 9" />
                        </svg>
                    </button>
                </td>
                <td className="mono">
                    <span className="warp-id">
                        {focused && (
                            <>
                                <FocusArrow />
                                <span className="sr-only">Focused warp: </span>
                            </>
                        )}
                        {text.warp}
                    </span>
                </td>
                <td className="mono">{text.sm}</td>
                <td>
                    <span
                        className="kernel-value full-text-value"
                        tabIndex={0}
                        data-tooltip={text.kernel}
                        aria-label={text.kernel}
                    >
                        <span className="kernel-name truncated-text">
                            {warp.kernelName ?? 'N/A'}
                        </span>
                        {(warp.kernelName !== null || warp.gridId !== null) && (
                            <span className="grid-id"> (grid {warp.gridId ?? 'N/A'})</span>
                        )}
                    </span>
                </td>
                <td className="mono" title={text.block}>
                    {text.block}
                </td>
                <td className="lanes-cell">
                    {/* The stop key resets lane navigation even when the physical warp survives. */}
                    <LaneStrip
                        key={stopId}
                        warp={warp}
                        onFocusLane={focusLane}
                        blocked={focusBlocked}
                        pendingLane={pendingLane}
                        focusedLane={focused ? (focus?.lane ?? null) : null}
                    />
                </td>
                <td className="mono">{text.activeMask}</td>
                <td className="mono" title={PC_HELP}>
                    {text.pc}
                </td>
            </tr>
            {open && (
                <tr className="lane-detail-row" data-warp-key={id} aria-rowindex={rowIndex + 1}>
                    <td colSpan={8} id={detailId}>
                        <LaneTable
                            key={stopId}
                            warp={warp}
                            focusedLane={focused ? (focus?.lane ?? null) : null}
                            onFocusLane={focusLane}
                            blocked={focusBlocked}
                            pendingLane={pendingLane}
                        />
                    </td>
                </tr>
            )}
        </tbody>
    );
}

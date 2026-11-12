/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import {
    Fragment,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactElement
} from 'react';
import {
    DEFAULT_PREFERENCES,
    type FocusTarget,
    type ViewPreferences,
    type WarpSnapshot
} from '../model';
import { WARP_COLUMNS, filterWarps, sortWarps, type Sort, type SortColumn } from './warpTable';
import { ColorLegend } from './components/colorLegend';
import { ViewTooltip } from './components/viewTooltip';
import { WarpRowGroup } from './components/warpRowGroup';
import { useColumnSizing } from './hooks/useColumnSizing';
import { usePinnedRows } from './hooks/usePinnedRows';
import { useVirtualWarps } from './hooks/useVirtualWarps';
import { useWarpExpansion } from './hooks/useWarpExpansion';

export function WarpInfo({
    snapshot,
    stale = false,
    message,
    loading = false,
    retrying,
    onRetry,
    stopId,
    deviceId,
    initialPreferences = DEFAULT_PREFERENCES,
    onPreferences,
    pendingFocus,
    focusBlocked,
    focusError,
    onFocusLane
}: {
    snapshot: WarpSnapshot | null;
    stale?: boolean;
    stopId?: string;
    deviceId?: number;
    initialPreferences?: ViewPreferences;
    onPreferences?: (preferences: ViewPreferences) => void;
    pendingFocus?: FocusTarget;
    focusBlocked?: boolean;
    focusError?: string;
    onFocusLane?: (target: FocusTarget) => void;
    message?: string;
    loading?: boolean;
    retrying?: boolean;
    onRetry?: (selection?: { sm: number; warp: number }) => void;
}): ReactElement {
    const view = useRef<HTMLElement>(null);
    const table = useRef<HTMLTableElement>(null);
    useColumnSizing(table, snapshot?.warps);
    const [draft, setDraft] = useState(initialPreferences.filter);
    const [filter, setFilter] = useState<RegExp | null>(() =>
        initialPreferences.filter ? new RegExp(initialPreferences.filter, 'i') : null
    );
    const applied = useRef(initialPreferences.filter);
    const [filterError, setFilterError] = useState<string | null>(null);
    const [sort, setSort] = useState<Sort>(initialPreferences.sort);
    const [legendOpen, setLegendOpen] = useState(false);
    const visible = useMemo(
        () => sortWarps(filterWarps(snapshot?.warps ?? [], filter), sort),
        [snapshot?.warps, filter, sort]
    );

    const { expanded, toggle } = useWarpExpansion(
        stale ? null : snapshot,
        visible,
        stopId,
        deviceId
    );
    const [focusedRow, setFocusedRow] = useState<string>();
    const { virtualizer, items, headerHeight, requestWarpJump } = useVirtualWarps(
        table,
        visible,
        expanded,
        snapshot?.device.id,
        focusedRow
    );
    const rendered = useMemo(() => items.map((item) => visible[item.index]), [items, visible]);
    usePinnedRows(table, rendered, expanded);
    const rowIndexes = useMemo(() => {
        let index = 2; // The overview header is row 1.
        return visible.map((warp) => {
            const row = index;
            index += expanded.has(`${warp.sm}:${warp.warp}`) ? 2 : 1;
            return row;
        });
    }, [visible, expanded]);
    const last = visible.at(-1);
    const rowCount = last
        ? rowIndexes.at(-1)! + (expanded.has(`${last.sm}:${last.warp}`) ? 1 : 0)
        : 1;
    const filterInput = useRef<HTMLInputElement>(null);
    const focusedControl = useRef<{ element: HTMLElement; row: string } | undefined>(undefined);
    // Moving rows can leave focus on the document body. Restore the original control
    // only if it survived and no other control took focus.
    useLayoutEffect(() => {
        if (!snapshot || stale) {
            setLegendOpen(false);
            focusedControl.current = undefined;
            setFocusedRow(undefined);
            return;
        }
        const focused = focusedControl.current;
        if (focused) {
            if (!visible.some((w) => `${w.sm}:${w.warp}` === focused.row))
                filterInput.current?.focus();
            else if (focused.element.isConnected && document.activeElement === document.body)
                focused.element.focus({ preventScroll: true });
        }
    }, [snapshot, stale, visible]);

    const failedWarps = snapshot?.warps.filter((warp) => warp.laneError) ?? [];
    const focus = snapshot?.focus;
    const focusedWarp = focus
        ? snapshot.warps.find((warp) => warp.sm === focus.sm && warp.warp === focus.warp)
        : undefined;
    const jumpUnavailable = !focus
        ? 'No CUDA focus is available.'
        : !focusedWarp
          ? 'The focused warp is not available in this view.'
          : !visible.includes(focusedWarp)
            ? 'The focused warp is hidden by the filter.'
            : undefined;

    const snapshotContext = snapshot && !stale ? `${stopId}:${snapshot.device.id}` : undefined;
    const previousSnapshotContext = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
        const newData = snapshotContext !== previousSnapshotContext.current;
        previousSnapshotContext.current = snapshotContext;
        // Follow completed acquisitions, not focus-only updates or local table interactions.
        if (newData && snapshotContext && expanded.size === 0 && focusedWarp && !jumpUnavailable)
            requestWarpJump({ warp: focusedWarp });
    }, [snapshotContext, expanded, focusedWarp, jumpUnavailable, requestWarpJump]);

    function applyFilter(): void {
        try {
            const expression = draft === '' ? null : new RegExp(draft, 'i');
            setFilter(expression);
            applied.current = draft;
            onPreferences?.({ filter: draft, sort });
            setFilterError(null);
        } catch {
            setFilterError('Invalid regular expression. The previous filter is still applied.');
        }
    }

    function escape(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (legendOpen) {
            setLegendOpen(false);
        } else {
            setDraft('');
            setFilter(null);
            applied.current = '';
            onPreferences?.({ filter: '', sort });
            setFilterError(null);
        }
    }

    function sortBy(column: SortColumn): void {
        const next: Sort = {
            column,
            direction:
                sort.column === column && sort.direction === 'ascending'
                    ? 'descending'
                    : 'ascending'
        };
        setSort(next);
        onPreferences?.({ filter: applied.current, sort: next });
    }

    if (snapshot === null) {
        return (
            <main className={`lifecycle-state${loading ? ' loading-state' : ''}`} role="status">
                {loading && <span className="loading-spinner" aria-hidden="true" />}
                <p>{message}</p>
                {onRetry && (
                    <button className="toolbar-button" type="button" onClick={() => onRetry()}>
                        Retry
                    </button>
                )}
            </main>
        );
    }

    return (
        <main
            ref={view}
            className="warp-info"
            onKeyDown={escape}
            onFocusCapture={(event) => {
                const element = event.target as HTMLElement;
                const row = element.closest<HTMLElement>('[data-warp-key]')?.dataset.warpKey;
                focusedControl.current = row ? { element, row } : undefined;
                setFocusedRow(row);
            }}
            onBlurCapture={(event) => {
                if (
                    event.relatedTarget &&
                    !event.currentTarget.contains(event.relatedTarget as Node)
                ) {
                    focusedControl.current = undefined;
                    setFocusedRow(undefined);
                }
            }}
        >
            <header className="toolbar">
                <div className="device">
                    <div className="device-name">
                        Device {snapshot.device.id} <span aria-hidden="true">·</span>{' '}
                        {snapshot.device.name ?? 'Name unavailable'}
                    </div>
                    <div className="view-summary">
                        <span role="status">
                            {filter === null
                                ? `${visible.length} warps`
                                : `${visible.length} of ${snapshot.warps.length} warps`}
                        </span>
                        <button
                            type="button"
                            className="toolbar-button jump-to-focus"
                            aria-disabled={jumpUnavailable !== undefined}
                            aria-description={jumpUnavailable ?? 'Reveal the current CUDA focus.'}
                            data-tooltip={jumpUnavailable ?? 'Reveal the current CUDA focus.'}
                            onClick={() => {
                                if (focusedWarp && !jumpUnavailable)
                                    requestWarpJump({
                                        warp: focusedWarp,
                                        lane: focus?.lane,
                                        emphasize: true
                                    });
                            }}
                        >
                            Jump to Focus
                        </button>
                    </div>
                </div>
                <div className="filter">
                    <label className="sr-only" htmlFor="warp-filter">
                        Filter warps (regex)
                    </label>
                    <input
                        id="warp-filter"
                        ref={filterInput}
                        type="text"
                        placeholder="Filter warps (regex)"
                        value={draft}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                applyFilter();
                            }
                        }}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setFilterError(null);
                        }}
                        aria-invalid={filterError !== null}
                        aria-describedby={filterError === null ? undefined : 'filter-error'}
                        spellCheck={false}
                        autoComplete="off"
                    />
                    {filterError && (
                        <div id="filter-error" className="filter-error" role="alert">
                            {filterError}
                        </div>
                    )}
                </div>
                <ColorLegend
                    open={legendOpen}
                    onToggle={() => setLegendOpen((value) => !value)}
                    onClose={() => setLegendOpen(false)}
                />
            </header>
            {focusError && (
                <p className="focus-error" role="alert">
                    {focusError}
                </p>
            )}
            {failedWarps.length > 0 && (
                <details className="lane-errors">
                    <summary>
                        Lane and exception data unavailable for {failedWarps.length}{' '}
                        {failedWarps.length === 1 ? 'warp' : 'warps'}.
                    </summary>
                    <ul>
                        {failedWarps.map((warp) => (
                            <li key={`${warp.sm}:${warp.warp}`}>
                                SM {warp.sm}, Warp {warp.warp}: {warp.laneError}{' '}
                                <button
                                    className="toolbar-button"
                                    type="button"
                                    disabled={retrying}
                                    onClick={() => onRetry?.({ sm: warp.sm, warp: warp.warp })}
                                >
                                    Retry
                                </button>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
            <div
                className="table-scroll"
                role="region"
                tabIndex={0}
                aria-label="Warp table, scroll horizontally for more columns"
            >
                <table ref={table} aria-label="Warp Info" aria-rowcount={rowCount}>
                    <colgroup>
                        <col className="column-expand" />
                        {WARP_COLUMNS.map(([key]) => (
                            <col key={key} className={`column-${key}`} />
                        ))}
                    </colgroup>
                    <thead>
                        <tr aria-rowindex={1}>
                            <th scope="col" aria-label="Lane details" />
                            {WARP_COLUMNS.map(([key, label, tooltip]) => (
                                <th
                                    key={key}
                                    scope="col"
                                    data-column={key}
                                    data-tooltip={tooltip}
                                    aria-description={tooltip}
                                    className={key === 'warp' ? 'warp-header' : undefined}
                                    aria-sort={sort.column === key ? sort.direction : undefined}
                                >
                                    {key === 'lanes' ? (
                                        <span className="column-label">{label}</span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => sortBy(key)}
                                            aria-description={tooltip}
                                            aria-label={`Sort by ${label}, ${sort.column === key && sort.direction === 'ascending' ? 'descending' : 'ascending'}`}
                                        >
                                            <span className="column-label">{label}</span>
                                            <span
                                                className={
                                                    sort.column === key
                                                        ? 'sort-active'
                                                        : 'sort-hint'
                                                }
                                                aria-hidden="true"
                                            >
                                                {sort.column === key
                                                    ? sort.direction === 'ascending'
                                                        ? '▴'
                                                        : '▾'
                                                    : '▴▾'}
                                            </span>
                                        </button>
                                    )}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    {items.map((item, index) => {
                        const warp = visible[item.index];
                        const gap = item.start - (items[index - 1]?.end ?? headerHeight);
                        const id = `${warp.sm}:${warp.warp}`;
                        return (
                            <Fragment key={`${snapshot.device.id}:${id}`}>
                                <Spacer height={gap} />
                                <WarpRowGroup
                                    warp={warp}
                                    device={snapshot.device.id}
                                    stopId={stopId}
                                    focus={snapshot.focus}
                                    pendingFocus={pendingFocus}
                                    focusBlocked={focusBlocked}
                                    onFocusLane={onFocusLane}
                                    open={expanded.has(id)}
                                    onToggle={() => toggle(warp)}
                                    virtualIndex={item.index}
                                    rowIndex={rowIndexes[item.index]}
                                    measureElement={virtualizer.measureElement}
                                />
                            </Fragment>
                        );
                    })}
                    <Spacer
                        height={
                            virtualizer.getTotalSize() +
                            headerHeight -
                            (items.at(-1)?.end ?? headerHeight)
                        }
                    />
                </table>
                {visible.length === 0 && (
                    <p className="empty-state" role="status">
                        {snapshot.warps.length === 0
                            ? 'No resident warps on this device.'
                            : 'No warps match this filter.'}
                    </p>
                )}
            </div>
            {!stale && <ViewTooltip viewRef={view} />}
        </main>
    );
}

/** Empty table space preserves native columns and the full scroll extent. */
function Spacer({ height }: { height: number }): ReactElement | null {
    return height > 0 ? (
        <tbody className="virtual-spacer" aria-hidden="true">
            <tr>
                <td colSpan={8} style={{ height }} />
            </tr>
        </tbody>
    ) : null;
}

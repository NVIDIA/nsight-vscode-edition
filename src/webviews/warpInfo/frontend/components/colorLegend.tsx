/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { LANE_STATES } from '../../presentation';
import { FocusArrow } from './laneStrip';

export function ColorLegend({
    open,
    onToggle,
    onClose
}: {
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
}): ReactElement {
    const container = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (!open) return;
        const dismiss = (event: PointerEvent): void => {
            if (event.target instanceof Node && !container.current?.contains(event.target))
                onClose();
        };
        const fit = (): void => {
            const popover = container.current?.querySelector<HTMLElement>('.legend-popover');
            if (popover)
                popover.style.maxHeight = `${Math.max(0, window.innerHeight - popover.getBoundingClientRect().top - 8)}px`;
        };
        fit();
        window.addEventListener('resize', fit);
        document.addEventListener('pointerdown', dismiss);
        return () => {
            window.removeEventListener('resize', fit);
            document.removeEventListener('pointerdown', dismiss);
        };
    }, [open, onClose]);

    return (
        <div className="legend" ref={container}>
            <button
                className="toolbar-button"
                type="button"
                aria-expanded={open}
                aria-controls="color-legend"
                onClick={onToggle}
            >
                Color legend
            </button>
            {open && (
                <section
                    id="color-legend"
                    className="legend-popover"
                    aria-label="Lane color legend"
                    tabIndex={0}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            onClose();
                            container.current?.querySelector('button')?.focus();
                        }
                    }}
                >
                    <ul>
                        {Object.entries(LANE_STATES).map(([state, item]) => (
                            <li key={state}>
                                <span
                                    className={`lane legend-sample lane-${state}`}
                                    aria-hidden="true"
                                />
                                <span>
                                    {item.label}
                                    {state === 'divergent' &&
                                        ': Valid lane outside the current active mask.'}
                                    {state === 'no-live-thread' &&
                                        ': Thread exited or lane was not launched.'}
                                </span>
                            </li>
                        ))}
                        <li>
                            <span className="legend-focus" aria-hidden="true">
                                <FocusArrow />
                            </span>
                            <span>Confirmed CUDA focus; overlays the lane state</span>
                        </li>
                    </ul>
                </section>
            )}
        </div>
    );
}

/* Copyright (c) 2026, NVIDIA CORPORATION. SPDX-License-Identifier: EPL-2.0 */

import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactElement,
    type RefObject
} from 'react';

/** Viewport-contained hints and scrollable full-value popovers. */
export function ViewTooltip({
    viewRef
}: {
    viewRef: RefObject<HTMLElement | null>;
}): ReactElement | null {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const popup = useRef<HTMLDivElement>(null);
    const [text, setText] = useState<string>();
    const fullValue = anchor?.classList.contains('full-text-value') ?? false;
    useLayoutEffect(() => {
        const update = (): void => {
            if (anchor && !anchor.isConnected) setAnchor(null);
            else setText(anchor?.dataset.tooltip);
        };
        update();
        if (!anchor) return;
        // Observe empty text too: a focused control can gain a disabled reason.
        const observer = new MutationObserver(update);
        observer.observe(anchor, { attributes: true, attributeFilter: ['data-tooltip'] });
        observer.observe(viewRef.current!, { childList: true, subtree: true });
        return () => observer.disconnect();
    }, [anchor, viewRef]);

    useEffect(() => {
        const view = viewRef.current!;
        const hide = (): void => {
            if (document.activeElement === popup.current) anchor?.focus({ preventScroll: true });
            setAnchor(null);
        };
        const handleKeyDown = (event: KeyboardEvent): void => {
            const box = popup.current;
            if (event.key === 'Escape' && box) {
                event.preventDefault();
                event.stopPropagation();
                hide();
            } else if (
                event.key === 'Enter' &&
                event.target === anchor &&
                fullValue &&
                box &&
                box.scrollHeight > box.clientHeight
            ) {
                event.preventDefault();
                box.focus({ preventScroll: true });
            }
        };
        const dismissOutsidePopup = (event: Event): void => {
            const target = event.target as Node;
            if (!popup.current || popup.current.contains(target)) return;
            if (event.type !== 'scroll' || target.contains(anchor)) hide();
        };
        const handleAnchor = (event: PointerEvent | FocusEvent): void => {
            if (popup.current?.contains(event.target as Node)) return;
            const target = (event.target as Element).closest<HTMLElement>('[data-tooltip]');
            if (event.type === 'pointerout' || event.type === 'focusout') {
                const next = event.relatedTarget;
                if (
                    !(next instanceof Node) ||
                    (!target?.contains(next) && !popup.current?.contains(next))
                )
                    hide();
            } else setAnchor(target);
        };
        // Hover requires movement so scrolling under a stationary pointer cannot reopen it.
        const events = ['pointermove', 'pointerout', 'focusin', 'focusout'] as const;
        for (const event of events) view.addEventListener(event, handleAnchor);
        // Dismiss the popup before the view handles Escape for its legend or filter.
        document.addEventListener('keydown', handleKeyDown, true);
        view.addEventListener('pointerdown', dismissOutsidePopup);
        view.addEventListener('scroll', dismissOutsidePopup, true);
        window.addEventListener('resize', hide);
        return () => {
            for (const event of events) view.removeEventListener(event, handleAnchor);
            document.removeEventListener('keydown', handleKeyDown, true);
            view.removeEventListener('pointerdown', dismissOutsidePopup);
            view.removeEventListener('scroll', dismissOutsidePopup, true);
            window.removeEventListener('resize', hide);
        };
    }, [viewRef, anchor, fullValue]);

    // Rows can move after any render, without changing tooltip text.
    useLayoutEffect(() => {
        const box = popup.current;
        if (!anchor?.isConnected || !box) return;
        const bounds = anchor.getBoundingClientRect();
        const { width, height } = box.getBoundingClientRect();
        box.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
        box.style.top = `${
            bounds.bottom + height <= window.innerHeight - 8
                ? bounds.bottom
                : Math.max(8, bounds.top - height)
        }px`;
        if (fullValue && box.scrollHeight > box.clientHeight) {
            anchor.setAttribute('aria-description', 'Press Enter to scroll the full value.');
            return () => anchor.removeAttribute('aria-description');
        }
        return undefined;
    });

    return anchor && text ? (
        <div
            ref={popup}
            className={`table-tooltip${fullValue ? ' full-value-tooltip' : ''}`}
            role={fullValue ? 'dialog' : 'tooltip'}
            aria-label={fullValue ? 'Full value' : undefined}
            tabIndex={fullValue ? -1 : undefined}
            onBlur={(event) => {
                if (event.relatedTarget !== anchor) setAnchor(null);
            }}
            onPointerLeave={(event) => {
                const next = event.relatedTarget;
                if (
                    document.activeElement !== popup.current &&
                    (!(next instanceof Node) || !anchor.contains(next))
                )
                    setAnchor(null);
            }}
        >
            {text}
        </div>
    ) : null;
}

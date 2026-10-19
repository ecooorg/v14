import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';

/**
 * Text fields that grow with their content, so everything the person typed is visible and editable without scrolling
 * inside the field. Height follows the text on typing, on programmatic changes (clearing after send), on pasted text,
 * when the width changes (rotation, window resize) and when web fonts finish loading.
 */

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function AutoTextarea({ style, onInput, ...props }, ref) {
  const inner = useRef<HTMLTextAreaElement>(null);
  const lastWidth = useRef(0);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

  const resize = useCallback(() => {
    const el = inner.current;
    if (!el) return;
    const before = el.offsetHeight;
    el.style.height = 'auto';
    const border = el.offsetHeight - el.clientHeight;          // top + bottom borders (box-sizing: border-box)
    const next = el.scrollHeight + border;
    el.style.height = `${next}px`;
    // The field grew while the person is typing in it: keep the line they are on above the keyboard / screen edge.
    if (next > before && document.activeElement === el) {
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const overflow = el.getBoundingClientRect().bottom - (viewport - 12);
      if (overflow > 0) window.scrollBy(0, overflow);
    }
  }, []);

  useLayoutEffect(resize, [resize, props.value]);

  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const w = el.clientWidth;
        if (w !== lastWidth.current) { lastWidth.current = w; resize(); }   // width changes re-wrap the text; height changes are ours
      });
      ro.observe(el);
    }
    void (document as any).fonts?.ready?.then(resize);
    return () => ro?.disconnect();
  }, [resize]);

  return (
    <textarea
      {...props}
      ref={inner}
      // flexBasis: a stylesheet `flex: 1` in a column container would otherwise override the height we set
      style={{ ...style, overflow: 'hidden', resize: 'none', flexBasis: 'auto' }}
      onInput={(e) => { resize(); onInput?.(e); }}
    />
  );
});

/**
 * A one-line text field that wraps and grows instead of cutting long text off. Enter does not add a line
 * (it behaves like a normal input); pasted line breaks become spaces.
 */
export const AutoInput = forwardRef<HTMLTextAreaElement, Omit<TextareaProps, 'rows' | 'wrap'>>(function AutoInput(
  { onChange, onKeyDown, className, ...props }, ref,
) {
  return (
    <AutoTextarea
      {...props}
      ref={ref}
      rows={1}
      className={`auto-input${className ? ` ${className}` : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault();
        onKeyDown?.(e);
      }}
      onChange={(e) => {
        if (/[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/[\r\n]+/g, ' ');
        onChange?.(e);
      }}
    />
  );
});

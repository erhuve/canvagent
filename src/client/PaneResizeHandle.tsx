import { useEffect, useRef, type KeyboardEvent } from "react";

type Props = {
  label: string;
  controls: string;
  className?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (immediate?: boolean) => void;
  onReset: () => void;
  onDraggingChange: (active: boolean) => void;
};

export function PaneResizeHandle(props: Props) {
  const drag = useRef<{ pointerId: number; x: number; value: number }>();
  const callbacks = useRef(props);
  callbacks.current = props;
  const finish = () => {
    if (!drag.current) return;
    drag.current = undefined;
    callbacks.current.onDraggingChange(false);
    callbacks.current.onCommit(true);
  };
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("blur", finish);
      if (drag.current) callbacks.current.onDraggingChange(false);
    };
  }, []);
  const clamp = (value: number) => Math.max(props.min, Math.min(props.max, value));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let value: number;
    const step = event.shiftKey ? 40 : 10;
    if (event.key === "ArrowLeft") value = props.value - step;
    else if (event.key === "ArrowRight") value = props.value + step;
    else if (event.key === "Home") value = props.min;
    else if (event.key === "End") value = props.max;
    else return;
    event.preventDefault();
    props.onChange(clamp(value));
    props.onCommit();
  };
  return <div
    className={`pane-resize-handle ${props.className ?? ""}`}
    role="separator"
    tabIndex={0}
    aria-label={props.label}
    aria-orientation="vertical"
    aria-controls={props.controls}
    aria-valuemin={Math.round(props.min)}
    aria-valuemax={Math.round(props.max)}
    aria-valuenow={Math.round(props.value)}
    aria-valuetext={`${Math.round(props.value)} pixels`}
    title="Drag to resize · Arrow keys adjust · Double-click to reset"
    onKeyDown={onKeyDown}
    onDoubleClick={() => props.onReset()}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, value: props.value };
      props.onDraggingChange(true);
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      props.onChange(clamp(current.value + event.clientX - current.x));
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
  />;
}

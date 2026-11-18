import clsx from 'clsx';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** One open dropdown at a time, anchored to its button like Cline's composer menus. */
const OpenMenu = createContext<{ openId: string | undefined; setOpenId: (id: string | undefined) => void }>({ openId: undefined, setOpenId: () => undefined });

export function MenuProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | undefined>();
  useEffect(() => {
    const close = () => setOpenId(undefined);
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, []);
  return <OpenMenu.Provider value={{ openId, setOpenId }}>{children}</OpenMenu.Provider>;
}

function menuItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button.menu-item:not(:disabled)'));
}

export function Dropdown(options: {
  id: string;
  button: ButtonHTMLAttributes<HTMLButtonElement>;
  buttonContent: ReactNode;
  menuRole: 'menu' | 'listbox';
  menuLabel: string;
  menuClassName?: string;
  /** Called when the menu opens. */
  onOpen?: () => void;
  children: (close: (focusButton?: boolean) => void) => ReactNode;
}) {
  const { openId, setOpenId } = useContext(OpenMenu);
  const open = openId === options.id;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback((focusButton = false) => {
    setOpenId(undefined);
    if (focusButton) buttonRef.current?.focus();
  }, [setOpenId]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const search = menu.querySelector<HTMLInputElement>('input.menu-search');
    (search ?? menu.querySelector<HTMLButtonElement>('button.menu-item[aria-selected="true"]') ?? menuItems(menu)[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const menu = menuRef.current;
      if (!menu) return;
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const items = menuItems(menu);
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
      items[next]?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open, close]);

  const menuId = `${options.id}-menu`;
  return (
    <div className="menu-anchor relative flex min-w-0">
      <button
        {...options.button}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup={options.menuRole}
        onClick={event => {
          options.button.onClick?.(event);
          if (open) { close(); return; }
          options.onOpen?.();
          setOpenId(options.id);
        }}
        ref={buttonRef}
        type="button">
        {options.buttonContent}
      </button>
      {open && (
        <div aria-label={options.menuLabel} className={clsx('menu', options.menuClassName)} id={menuId} ref={menuRef} role={options.menuRole}>
          {options.children(close)}
        </div>
      )}
    </div>
  );
}

export function MenuItem(options: { label: string; detail?: string; selected?: boolean; role: string; disabled?: boolean; onPick: () => void; close: (focusButton?: boolean) => void; className?: string; leading?: ReactNode }) {
  return (
    <button
      aria-checked={options.role === 'menuitemradio' ? !!options.selected : undefined}
      aria-selected={options.role === 'option' ? !!options.selected : undefined}
      className={clsx('menu-item', options.className)}
      disabled={options.disabled}
      onClick={() => { options.close(true); options.onPick(); }}
      role={options.role}
      title={options.label}
      type="button">
      {options.leading}
      <span className="menu-label">{options.label}</span>
      {options.detail && <span className="menu-detail">{options.detail}</span>}
      <span aria-hidden="true" className="menu-check">{options.selected ? '✓' : ''}</span>
    </button>
  );
}

export function MenuNote({ text, className = 'menu-note' }: { text: string; className?: string }) {
  return <div className={className}>{text}</div>;
}

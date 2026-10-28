import { useEffect } from 'react';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-2 sm:items-center sm:p-6" onClick={onClose}>
      <div className={`card dm-pop flex max-h-[92vh] w-full flex-col ${wide ? 'max-w-4xl' : 'max-w-lg'}`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="rune-title">{title}</h2>
          <button className="btn-ghost ml-auto" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="scroll-thin min-h-0 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

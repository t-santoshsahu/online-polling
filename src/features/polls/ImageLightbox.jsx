import { useEffect, useState } from 'react'

export default function ImageLightbox({ src, alt, className = '' }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return

    function closeOnEscape(event) {
      if (event.key === 'Escape') setOpen(false)
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <>
      <button
        className={`group relative block shrink-0 overflow-hidden rounded-lg focus-visible:outline ${className}`}
        type="button"
        aria-label={`View full-size image: ${alt || 'poll option'}`}
        onClick={() => setOpen(true)}
      >
        <img className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" src={src} alt={alt} />
        <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[9px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">View</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[#101814]/90 p-3 backdrop-blur-sm sm:p-8"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <section
            className="relative flex max-h-full max-w-full flex-col items-center"
            role="dialog"
            aria-modal="true"
            aria-label={alt || 'Poll option image'}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="absolute -right-2 -top-2 z-10 grid size-11 place-items-center rounded-full border border-white/30 bg-[#1d3029] text-2xl leading-none text-white shadow-lg hover:bg-[#39745a] sm:right-2 sm:top-2"
              type="button"
              aria-label="Close full-size image"
              onClick={() => setOpen(false)}
            >
              &times;
            </button>
            <img className="max-h-[88svh] max-w-full rounded-xl object-contain shadow-2xl" src={src} alt={alt} />
            {alt && <p className="mt-3 max-w-full truncate rounded-full bg-black/50 px-4 py-2 text-sm text-white">{alt}</p>}
          </section>
        </div>
      )}
    </>
  )
}

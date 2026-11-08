import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function ImageLightbox({ src, images, alt, className = '' }) {
  const [open, setOpen] = useState(false)
  const [imageIndex, setImageIndex] = useState(0)
  const touchStart = useRef(null)
  const lastSwipe = useRef(0)
  const triggerRef = useRef(null)
  const closeRef = useRef(null)
  const dialogRef = useRef(null)
  const imageUrls = images?.length ? images : [src]

  useEffect(() => {
    if (!open) return

    function closeOnEscape(event) {
      if (event.key === 'Escape') setOpen(false)
      if (event.key === 'ArrowLeft') setImageIndex((index) => (index - 1 + imageUrls.length) % imageUrls.length)
      if (event.key === 'ArrowRight') setImageIndex((index) => (index + 1) % imageUrls.length)
      if (event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll('button:not(:disabled)')
        if (!buttons?.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    const previousOverflow = document.body.style.overflow
    const trigger = triggerRef.current
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
      trigger?.focus()
    }
  }, [open, imageUrls.length])

  return (
    <>
      <button
        ref={triggerRef}
        className={`group relative block shrink-0 overflow-hidden rounded-lg focus-visible:outline ${className}`}
        type="button"
        aria-label={imageUrls.length > 1 ? `View ${imageUrls.length} photos: ${alt || 'poll option'}` : `View full-size image: ${alt || 'poll option'}`}
        onClick={() => { setImageIndex(0); setOpen(true) }}
      >
        <img className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105" src={imageUrls[0]} alt={alt} />
        {imageUrls.length > 1 && <span aria-hidden="true" className="absolute right-0 top-0 rounded-bl-md bg-black/80 px-1 py-0.5 text-[10px] font-semibold leading-tight text-white">{imageUrls.length} photos</span>}
        <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 py-0.5 text-center text-[9px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">View</span>
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[100] h-[100dvh] w-full bg-[#101814]/95"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <section
            ref={dialogRef}
            className="flex h-full w-full flex-col text-white"
            style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
            role="dialog"
            aria-modal="true"
            aria-label={alt || 'Poll option image'}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex min-h-16 shrink-0 items-center gap-3 px-4 sm:px-6">
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">{alt || 'Poll option image'}</p>
              <button
                ref={closeRef}
                className="grid size-12 shrink-0 place-items-center rounded-full border border-white/30 bg-[#1d3029] text-3xl leading-none hover:bg-[#39745a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                type="button"
                aria-label="Close full-size image"
                onClick={() => setOpen(false)}
              >
                &times;
              </button>
            </header>
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center px-3 sm:px-16"
              style={{ touchAction: 'pan-y pinch-zoom' }}
              onClick={(event) => { if (event.target === event.currentTarget && Date.now() - lastSwipe.current > 500) setOpen(false) }}
              onTouchStart={(event) => {
                touchStart.current = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null
              }}
              onTouchMove={(event) => {
                if (event.touches.length !== 1) touchStart.current = null
              }}
              onTouchEnd={(event) => {
                if (!touchStart.current || event.touches.length || imageUrls.length < 2) return
                const deltaX = event.changedTouches[0].clientX - touchStart.current.x
                const deltaY = event.changedTouches[0].clientY - touchStart.current.y
                touchStart.current = null
                if (Math.abs(deltaX) < 60 || Math.abs(deltaX) <= Math.abs(deltaY)) return
                lastSwipe.current = Date.now()
                setImageIndex((index) => (index + (deltaX < 0 ? 1 : -1) + imageUrls.length) % imageUrls.length)
              }}
              onTouchCancel={() => { touchStart.current = null }}
            >
              <img className="h-full w-full object-contain" src={imageUrls[imageIndex]} alt={alt} draggable="false" />
              {imageUrls.length > 1 && (
                <>
                  <button className="absolute left-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/50 bg-black/70 text-3xl leading-none hover:bg-[#39745a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white sm:left-4" type="button" aria-label="Previous image" onClick={() => setImageIndex((index) => (index - 1 + imageUrls.length) % imageUrls.length)}>&lsaquo;</button>
                  <button className="absolute right-2 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-white/50 bg-black/70 text-3xl leading-none hover:bg-[#39745a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white sm:right-4" type="button" aria-label="Next image" onClick={() => setImageIndex((index) => (index + 1) % imageUrls.length)}>&rsaquo;</button>
                </>
              )}
            </div>
            {imageUrls.length > 1 && (
              <nav className="flex min-h-12 shrink-0 items-center justify-center px-4" aria-label="Image gallery navigation">
                <span className="min-w-16 text-center text-sm font-semibold tabular-nums" aria-live="polite">{imageIndex + 1} / {imageUrls.length}</span>
              </nav>
            )}
          </section>
        </div>, document.body
      )}
    </>
  )
}

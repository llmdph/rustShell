import { useEffect, useState, type CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

function Toaster({ ...props }: ToasterProps) {
  const [theme, setTheme] = useState<"light" | "dark">(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light"
  )
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setTheme(el.classList.contains("dark") ? "dark" : "light"))
    obs.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => obs.disconnect()
  }, [])
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={{
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--border)",
      } as CSSProperties}
      {...props}
    />
  )
}
export { Toaster }

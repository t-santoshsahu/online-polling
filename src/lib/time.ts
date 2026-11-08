const societyTimeZone = 'Asia/Kolkata'

export function hasDeadlinePassed(deadline: string, now = new Date()): boolean {
  return new Date(deadline).getTime() <= now.getTime()
}

export function formatDeadlineIST(deadline: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: societyTimeZone,
  }).format(new Date(deadline))
}
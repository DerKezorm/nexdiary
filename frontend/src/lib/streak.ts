import type { StreakView, TodayData } from '../api/client'

/** The streak of the day's data; a server that sends only the number is read as days with no shields. */
export function seriesOf(data: TodayData): StreakView {
  return (
    data.series ?? {
      unit: 'days',
      goal: 7,
      current: data.streak,
      longest: data.streak,
      longest_end: null,
      today_done: false,
      shields: 0,
      week: { count: 0, goal: 7 },
      rescues: [],
    }
  )
}

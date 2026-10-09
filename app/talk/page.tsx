/**
 * TD Talk's one page: the existing Team Chat workspace, unchanged. Re-exported (not copied) so the two can
 * never drift — a fix to Team Chat is a fix to TD Talk. The page itself knows when it is running under /talk
 * (usePathname) and adjusts only its height, its deep links and its first screen on a phone.
 */
export { default } from '@/app/(dashboard)/team-chat/page'

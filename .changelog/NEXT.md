## Fixed

- Tapping the notifications bell on a phone now opens a panel that stays on screen. It was anchored to the bell — which sits mid-screen in the sidebar — so the panel ran off the right edge, clipping notification titles and putting every per-item dismiss button and the mark-all/clear-all controls out of reach with nothing to scroll to them.
- The notification panel's "+N more notifications" line is now a "Show N more" button, so the notifications past the first ten can be read and dismissed instead of being permanently unreachable.
- Notification dismiss and "Mark read" buttons are now full-size, always-visible tap targets on touch devices — they were sized to their bare icon, and the dismiss button was only revealed on hover, which a phone has no way to do.
- The notification panel now closes on Escape, and long notification descriptions wrap to two lines instead of being cut off mid-word.

## Changed

- Notification panel placement now goes through the shared popover-positioning hook that the theme switcher beside it already used, so it clamps into the viewport and flips above/below on its own instead of relying on hand-written positioning.

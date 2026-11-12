import { renderMarketingPage } from './landing.js';

/**
 * The root domain's SeatBook marketing page, served at /library.
 *
 * The same page as GymBook's (views/landing.js) — layout, sign-in box,
 * demos and all — with SeatBook's words (public/js/marketing.js), its
 * colours (data-brand="library" in app.css) and its own interactive demo:
 * the live seat map instead of the check-in desk.
 */
export const renderLandingLibrary = (ctx) => renderMarketingPage('library', ctx);

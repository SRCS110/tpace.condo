// api/calendar.js — Vercel Serverless Function
// Fetches & merges Airbnb + VRBO iCal feeds, returns booked date ranges as JSON.
//
// Set these in your Vercel project's Environment Variables:
//   AIRBNB_ICAL_URL  — from Airbnb: Calendar → Availability Settings → Export Calendar
//   VRBO_ICAL_URL    — from VRBO: Calendar → Import/Export → Export Calendar

export const config = { runtime: 'edge' };

export default async function handler(req) {
  // CORS headers so your HTML page can call this endpoint
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
  };

  const airbnbUrl = process.env.AIRBNB_ICAL_URL;
  const vrboUrl   = process.env.VRBO_ICAL_URL;

  if (!airbnbUrl && !vrboUrl) {
    return new Response(
      JSON.stringify({ error: 'No iCal URLs configured. Set AIRBNB_ICAL_URL and/or VRBO_ICAL_URL in Vercel environment variables.' }),
      { status: 500, headers }
    );
  }

  try {
    // Fetch both feeds in parallel (skip if URL not set)
    const fetches = await Promise.allSettled([
      airbnbUrl ? fetch(airbnbUrl).then(r => r.text()) : Promise.resolve(''),
      vrboUrl   ? fetch(vrboUrl).then(r => r.text())   : Promise.resolve(''),
    ]);

    const airbnbIcal = fetches[0].status === 'fulfilled' ? fetches[0].value : '';
    const vrboIcal   = fetches[1].status === 'fulfilled' ? fetches[1].value : '';

    // Parse both feeds and merge
    const bookedRanges = [
      ...parseIcal(airbnbIcal, 'airbnb'),
      ...parseIcal(vrboIcal,   'vrbo'),
    ];

    return new Response(
      JSON.stringify({ bookedRanges, fetchedAt: new Date().toISOString() }),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers }
    );
  }
}

/**
 * Parse an iCal string and return an array of { start, end, summary, source } objects.
 * Dates are returned as 'YYYY-MM-DD' strings (inclusive start, exclusive end).
 */
function parseIcal(ical, source) {
  if (!ical) return [];

  const ranges = [];
  // Split into VEVENT blocks
  const events = ical.split('BEGIN:VEVENT').slice(1);

  for (const event of events) {
    const summary = extractField(event, 'SUMMARY') || '';

    // Skip availability/open blocks (Airbnb exports "Airbnb (Not available)" for blocked dates
    // and some platforms export open windows too — we only want booked/blocked entries)
    const lowerSummary = summary.toLowerCase();
    if (
      lowerSummary.includes('available') ||
      lowerSummary === 'open' ||
      lowerSummary === ''
    ) {
      // Still include it — "Airbnb (Not available)" means blocked
      // Only skip if explicitly "available" without "not"
      if (lowerSummary === 'available' || lowerSummary === 'open') continue;
    }

    // DTSTART and DTEND can be:
    //   DTSTART;VALUE=DATE:20260810   (all-day, most common)
    //   DTSTART:20260810T000000Z      (datetime)
    const dtstart = extractField(event, 'DTSTART') || extractField(event, 'DTSTART;VALUE=DATE');
    const dtend   = extractField(event, 'DTEND')   || extractField(event, 'DTEND;VALUE=DATE');

    if (!dtstart || !dtend) continue;

    const start = parseIcalDate(dtstart);
    const end   = parseIcalDate(dtend);

    if (!start || !end) continue;

    ranges.push({ start, end, summary, source });
  }

  return ranges;
}

/** Pull a field value from a VEVENT block, handling folded lines */
function extractField(block, field) {
  // Unfold lines first (iCal lines can be continued with CRLF + whitespace)
  const unfolded = block.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  for (const line of lines) {
    // Match field name possibly followed by parameters (e.g. DTSTART;VALUE=DATE:...)
    if (line.startsWith(field + ':') || line.startsWith(field + ';')) {
      return line.split(':').slice(1).join(':').trim();
    }
  }
  return null;
}

/** Convert iCal date string to YYYY-MM-DD */
function parseIcalDate(raw) {
  // All-day: 20260810
  // DateTime: 20260810T000000Z or 20260810T000000
  const digits = raw.replace(/[TZ]/g, '').slice(0, 8);
  if (digits.length !== 8 || isNaN(Number(digits))) return null;
  return `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
}

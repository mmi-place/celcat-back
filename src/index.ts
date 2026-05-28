import express from "express";
import { Request, Response, NextFunction } from "express";
import cors from "cors";
import ical from "ical";
import NodeCache from "node-cache";

const app = express();
const port = process.env.PORT || 5000;

const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || "600", 10);
const CELCAT_BASE_URL =
  process.env.CELCAT_BASE_URL ||
  "https://celcat.rambouillet.iut-velizy.uvsq.fr";
const CELCAT_EDT_URL =
  process.env.CELCAT_EDT_URL ||
  "https://edt.rambouillet.iut-velizy.uvsq.fr";

app.use(cors());

// ---------------------------------------------------------------------------
// Mapping groupId (iCal) -> federationId (POST)
// ---------------------------------------------------------------------------
const GROUP_TO_FEDERATION: Record<string, string> = {
  "G1-QJ2DMFYC5987": "MMI1-A1",
  "G1-PW2GUKMM5988": "MMI1-A2",
  "G1-HN2CHYNX5990": "MMI1-B1",
  "G1-QW2SJTJH5991": "MMI1-B2",
  "G1-QS2QEJVB5994": "MMI2-A1",
  "G1-EG2LDXAM5995": "MMI2-A2",
  "G1-AE2BGJHX5997": "MMI2-B1",
  "G1-TM2VJCBU5998": "MMI2-B2",
  "G1-TS2PGRAD6003": "MMI3-FA-DW-A1",
  "G1-KL2GMWYW6004": "MMI3-FA-DW-A2",
  "G1-EB2URAPF6006": "MMI3-FI-CN-A1",
  "G1-JP2NSAYC6007": "MMI3-FI-CN-A2",
  "G1-CC2LTGMX6000": "MMI3-FA-CN-A1",
  "G1-HW2LKCBM6001": "MMI3-FA-CN-A2",
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
class AppError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class ClientError extends AppError {
  constructor(message: string, statusCode = 400) {
    super(message, statusCode);
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CalendarEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  description: string;

  eventCategory?: string;
  modules?: string[] | null;
  department?: string;
  faculty?: string;
  sites?: string[] | null;
  allDay?: boolean;
  backgroundColor?: string;
  textColor?: string;
}

interface CelcatPostEvent {
  id: string;
  start: string;
  end: string | null;
  allDay: boolean;
  description: string;
  backgroundColor: string;
  textColor: string;
  department: string;
  faculty: string;
  eventCategory: string;
  sites: string[] | null;
  modules: string[] | null;
  registerStatus: number;
  studentMark: number;
  custom1: null;
  custom2: null;
  custom3: null;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function decodeHtml(str: string): string {
  if (!str) return "";
  return str.replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// Analyseur POST Celcat (normalisation)
// ---------------------------------------------------------------------------

// Découpe description en prof / groupe / salles / bloc module éventuel
function parseCelcatDescription(ev: CelcatPostEvent) {
  const parts = ev.description
    .split("<br />")
    .map((p) => p.replace(/\r\n/g, "").trim())
    .filter(Boolean);

  const teacher = parts[0] || "Inconnu";
  const group = parts[1] || "Tous";

  const siteCount = Array.isArray(ev.sites) ? ev.sites.length : 0;
  const roomStartIndex = 2;
  const roomEndIndex = roomStartIndex + siteCount;

  const rooms = parts.slice(roomStartIndex, roomEndIndex);
  const room = rooms.join(" / ") || "";

  const moduleIndex = roomEndIndex;
  const moduleBlock = parts[moduleIndex] || "";

  return {
    teacher,
    group,
    rooms,
    room,
    moduleBlock,
  };
}

// Extraction moduleCode / codeSimplifier / moduleLabel / summary à partir du bloc module
function parseModuleFromBlock(moduleBlock: string) {
  if (!moduleBlock) {
    return {
      moduleCode: "",
      codeSimplifier: "",
      moduleLabel: "",
      summary: "",
    };
  }

  const codeMatch = moduleBlock.match(/\[(.*?)\]/);
  const moduleCode = codeMatch ? codeMatch[1] : "";

  let withoutCode = moduleBlock.replace(/\s*\[.*?\]\s*$/, "").trim();
  withoutCode = decodeHtml(withoutCode);

  let codeSimplifier = "";
  let summary = "";
  let moduleLabel = "";

  const parts = withoutCode.split(" - ");
  if (parts.length >= 2) {
    codeSimplifier = parts[0].trim();
    summary = parts.slice(1).join(" - ").trim();
    moduleLabel = `${codeSimplifier} - ${summary}`;
  } else {
    summary = withoutCode;
    moduleLabel = withoutCode;
  }

  return {
    moduleCode,
    codeSimplifier,
    moduleLabel,
    summary,
  };
}

// Fonction unique de normalisation
function normalizeEvent(ev: CelcatPostEvent) {
  const descInfo = parseCelcatDescription(ev);
  const moduleInfo = parseModuleFromBlock(descInfo.moduleBlock);

  let moduleCode = moduleInfo.moduleCode;
  if (ev.modules && ev.modules.length) {
    moduleCode = ev.modules[0];
  }

  return {
    teacher: descInfo.teacher,
    group: descInfo.group,
    room: descInfo.room, // "E57 - VEL" ou "E57 - VEL / I22 - VEL"
    moduleCode, // "MM2R18" / "MM2SA02" / ""
    codeSimplifier: moduleInfo.codeSimplifier, // "R218"
    moduleLabel: moduleInfo.moduleLabel, // "R218 - Economie..."
    summaryLabel: moduleInfo.summary, // "Economie et Droit du numerique"
  };
}

// ---------------------------------------------------------------------------
// Helpers POST → CalendarEvent (rétrocompat SDK)
// ---------------------------------------------------------------------------

/**
 * SUMMARY iCal-like :
 * - "MODULE - Libellé\; Type" si moduleLabel existe
 * - "Catégorie" seule sinon (ex: "projet tutore")
 */
function buildSummary(event: CelcatPostEvent): string {
  const meta = normalizeEvent(event);
  const category = (event.eventCategory || "").trim();

  // Cas général : moduleLabel dispo → "MODULE - Libellé\; Type"
  if (meta.moduleLabel) {
    return `${meta.moduleLabel}\\; ${category || ""}`.trim();
  }

  // Pas de moduleLabel mais summaryLabel → "Summary\; Type"
  if (meta.summaryLabel) {
    return `${meta.summaryLabel}\\; ${category || ""}`.trim();
  }

  // Pas de libellé de module : utiliser la catégorie seule (ex: "projet tutore")
  if (category) {
    return category;
  }

  // Fallback
  return `inconnu\\; ${event.eventCategory || "Type inconnu"}`;
}

/**
 * DESCRIPTION iCal-like :
 * "PROF(s); GROUPE\n\nEvent id: X, Register id: N/A"
 */
function buildDescription(event: CelcatPostEvent): string {
  const meta = normalizeEvent(event);
  const eventId = event.id.split(":")[3] || event.id;
  const registerId = "N/A"; // placeholder, Celcat POST ne donne pas Register id

  const teacherPart = meta.teacher;
  const groupPart = meta.group;

  return `${teacherPart}\\; ${groupPart}\\n\\nEvent id: ${eventId}, Register id: ${registerId}`;
}

/**
 * LOCATION iCal-like :
 * "SALLE - VEL" ou "SALLE1 - VEL; SALLE2 - VEL"
 */
function buildLocation(event: CelcatPostEvent): string {
  const parts = event.description.split("<br />");

  const rawRooms = (parts[2] || "")
    .split(/\r\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const roomCount =
    Array.isArray(event.sites) && event.sites.length > 0
      ? event.sites.length
      : rawRooms.length;

  const rooms = rawRooms.slice(0, roomCount);

  return rooms.join("; ") || "";
}

function postEventToCalendarEvent(event: CelcatPostEvent): CalendarEvent {
  return {
    uid: event.id,
    summary: buildSummary(event),
    start: event.start,
    end: event.end ?? event.start,
    location: buildLocation(event),
    description: buildDescription(event),

    eventCategory: event.eventCategory,
    modules: event.modules,
    department: event.department,
    faculty: event.faculty,
    sites: event.sites,
    allDay: event.allDay,
    backgroundColor: event.backgroundColor,
    textColor: event.textColor,
  };
}

// ---------------------------------------------------------------------------
// Stratégie POST
// ---------------------------------------------------------------------------
async function fetchViaPost(
  federationId: string,
  start: string,
  end: string
): Promise<CalendarEvent[]> {
  const cacheKey = `post_${federationId}_${start}_${end}`;
  const cached = cache.get<CalendarEvent[]>(cacheKey);
  if (cached) return cached;

  const body = new URLSearchParams({
    start,
    end,
    resType: "103",
    calView: "agendaWeek",
    "federationIds[]": federationId,
  });

  const response = await fetch(`${CELCAT_EDT_URL}/Home/GetCalendarData`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body,
  });

  if (!response.ok) {
    throw new AppError(`POST Celcat failed. Status: ${response.status}`, 502);
  }

  const raw: CelcatPostEvent[] = (await response.json()) as CelcatPostEvent[];
  const events = raw
    .filter((e) => !e.allDay)
    .map(postEventToCalendarEvent)
    .sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );

  cache.set(cacheKey, events);
  return events;
}

// ---------------------------------------------------------------------------
// Stratégie iCal (fallback)
// ---------------------------------------------------------------------------
function dateToYyyymmdd(date: Date | undefined): number {
  if (!date || isNaN(date.getTime())) return 0;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return parseInt(`${y}${m}${d}`);
}

async function fetchViaIcal(
  groupId: string,
  startDate: Date,
  endDate?: Date
): Promise<CalendarEvent[]> {
  const cacheKey = `ical_${groupId}`;
  let icalData = cache.get<string>(cacheKey);

  if (!icalData) {
    const response = await fetch(
      `${CELCAT_BASE_URL}/cal/ical/${groupId}/schedule.ics`
    );
    if (!response.ok) {
      if (response.status === 404)
        throw new ClientError(
          `No schedule found for group ID: ${groupId}`,
          404
        );
      throw new AppError(`iCal fetch failed. Status: ${response.status}`, 502);
    }
    icalData = await response.text();
    cache.set(cacheKey, icalData);
  }

  const calendar = ical.parseICS(icalData);
  const startN = dateToYyyymmdd(startDate);
  const endN = endDate ? dateToYyyymmdd(endDate) : startN + 5;

  const events: CalendarEvent[] = Object.values(calendar)
    .filter((e: any) => e.type === "VEVENT")
    .map((e: any) => {
      e.start.setSeconds(0, 0);
      e.end.setSeconds(0, 0);
      return {
        uid: e.uid,
        summary: e.summary,
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        location: e.location,
        description: e.description,
      };
    })
    .filter((e) => {
      const n = dateToYyyymmdd(new Date(e.start));
      return n >= startN && n <= endN;
    })
    .sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );

  return events;
}

// ---------------------------------------------------------------------------
// Route principale
// ---------------------------------------------------------------------------
app.get(
  "/edt/:groupId",
  async (req: Request, res: Response, next: NextFunction) => {
    const { groupId } = req.params;
    const { start, end } = req.query;

    if (!start)
      return next(new ClientError("Missing 'start' query parameter."));

    const startDate = new Date(start.toString());
    if (isNaN(startDate.getTime()))
      return next(new ClientError("Invalid 'start' date format."));

    const endDate = end ? new Date(end.toString()) : undefined;
    if (end && isNaN(endDate!.getTime()))
      return next(new ClientError("Invalid 'end' date format."));

    const startStr = start.toString().split("T")[0]!;
    const endStr = end ? end.toString().split("T")[0]! : startStr;

    const federationId = GROUP_TO_FEDERATION[groupId];

    try {
      if (federationId) {
        try {
          console.log(`[POST] Fetching ${groupId} (${federationId})`);
          const events = await fetchViaPost(federationId, startStr, endStr);
          return res.status(200).json(events);
        } catch (postError) {
          console.warn(
            `[POST] Failed for ${groupId}, falling back to iCal. Error: ${postError}`
          );
        }
      } else {
        console.warn(
          `[MAP] No federationId for "${groupId}", using iCal directly.`
        );
      }

      console.log(`[iCal] Fetching ${groupId}`);
      const events = await fetchViaIcal(groupId, startDate, endDate);
      return res.status(200).json(events);
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------
app.post("/ping", (_req, res) => {
  res.status(200).send("pong");
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use(
  (err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      console.error(
        `[${req.method} ${req.path}] AppError ${err.statusCode}: ${err.message}`
      );
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error(err.stack);
    res
      .status(500)
      .json({ error: "An unexpected internal server error occurred." });
  }
);

// ---------------------------------------------------------------------------
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});

export interface EvalCase {
  name: string;
  prompt: string;
  expectedTool: string;
  assertions: (args: Record<string, unknown>) => string[];
}

const MS_PER_DAY = 86_400_000;

/**
 * The first day, last day and length of a range of whole days: "YYYY-MM-DD,YYYY-MM-DD", or
 * the same days as datetimes from 00:00:00 to 23:59:59 at any offset.
 */
function dayRange(value: unknown): { first: string; last: string; days: number } | undefined {
  const offset = String.raw`(?:Z|[+-]\d{2}:\d{2})`;
  const match = new RegExp(
    String.raw`^(\d{4}-\d{2}-\d{2})(?:T00:00:00${offset})?,(\d{4}-\d{2}-\d{2})(?:T23:59:59${offset})?$`
  ).exec(String(value));
  if (!match) return undefined;
  const [, first, last] = match;
  return { first, last, days: (Date.parse(last) - Date.parse(first)) / MS_PER_DAY + 1 };
}

export const cases: EvalCase[] = [
  {
    name: "before/after deploy comparison",
    prompt:
      "Did traffic to /pricing drop after March 15, 2024? Compare the week before and after.",
    expectedTool: "compare_periods",
    assertions: (args) => {
      const errors: string[] = [];
      if (!String(args.page ?? "").includes("/pricing")) {
        errors.push(`Expected page to include "/pricing", got "${args.page}"`);
      }
      // The week after starts on the deploy day or the day after it. The week before ends
      // the day before the deploy, whether given or left to compare_periods to compute.
      const after = dayRange(args.period_b);
      if (!after || after.days !== 7 || !["2024-03-15", "2024-03-16"].includes(after.first)) {
        errors.push(`Expected period_b to be the 7 days from 2024-03-15 or 2024-03-16, got "${args.period_b}"`);
      }
      const before = args.period_a === undefined ? undefined : dayRange(args.period_a);
      if (args.period_a === undefined && after?.first !== "2024-03-15") {
        errors.push("Without period_a, period_b must start on 2024-03-15 so the computed week before ends on 2024-03-14");
      }
      if (args.period_a !== undefined && (before?.days !== 7 || before.last !== "2024-03-14")) {
        errors.push(`Expected period_a to be the 7 days ending 2024-03-14, got "${args.period_a}"`);
      }
      return errors;
    },
  },
  {
    name: "daily visitors timeseries",
    prompt: "Show me daily visitors for example.com for the last 30 days.",
    expectedTool: "get_timeseries",
    assertions: (args) => {
      const errors: string[] = [];
      if (args.date_range !== "30d" && !String(args.date_range).includes(",")) {
        errors.push(`Expected date_range "30d" or date pair, got "${args.date_range}"`);
      }
      return errors;
    },
  },
  {
    name: "top pages breakdown",
    prompt: "What are our top pages by traffic this month for example.com?",
    expectedTool: "get_breakdown",
    assertions: (args) => {
      const errors: string[] = [];
      if (args.dimension !== "event:page") {
        errors.push(
          `Expected dimension "event:page", got "${args.dimension}"`
        );
      }
      return errors;
    },
  },
  {
    name: "conversion rate query",
    prompt:
      "What's the signup conversion rate on /pricing for example.com this month?",
    expectedTool: "get_conversions",
    assertions: (args) => {
      const errors: string[] = [];
      const goal = String(args.goal ?? "").toLowerCase();
      if (!goal.includes("signup")) {
        errors.push(`Expected goal to contain "signup", got "${args.goal}"`);
      }
      if (!String(args.page ?? "").includes("/pricing")) {
        errors.push(`Expected page to include "/pricing", got "${args.page}"`);
      }
      return errors;
    },
  },
  {
    name: "bounce rate week-over-week comparison",
    prompt:
      "How does this week's bounce rate compare to last week for /blog on example.com?",
    expectedTool: "compare_periods",
    assertions: (args) => {
      const errors: string[] = [];
      if (!String(args.page ?? "").includes("/blog")) {
        errors.push(`Expected page to include "/blog", got "${args.page}"`);
      }
      const metrics = args.metrics as string[] | undefined;
      if (metrics && !metrics.includes("bounce_rate")) {
        errors.push(
          `Expected metrics to include "bounce_rate", got ${JSON.stringify(metrics)}`
        );
      }
      // The prompt gives no date, so the only right call is the last 7 days against the
      // 7 days before them, which compare_periods computes when period_a is left out.
      if (args.period_b !== "7d" || args.period_a !== undefined) {
        errors.push(
          `Expected period_b "7d" and no period_a, got period_a ${JSON.stringify(args.period_a)} and period_b ${JSON.stringify(args.period_b)}`
        );
      }
      return errors;
    },
  },
  {
    name: "traffic by country (human-readable names)",
    prompt:
      "Which countries send the most visitors to example.com this month? Show country names.",
    expectedTool: "get_breakdown",
    assertions: (args) => {
      const errors: string[] = [];
      const dimension = String(args.dimension ?? "");
      if (dimension !== "visit:country_name" && dimension !== "visit:country") {
        errors.push(
          `Expected dimension "visit:country_name" (or "visit:country"), got "${dimension}"`
        );
      }
      return errors;
    },
  },
  {
    name: "breakdown by a custom property",
    prompt:
      "Break down visitors by the custom property `destination_host` for example.com this month.",
    expectedTool: "get_breakdown",
    assertions: (args) => {
      const errors: string[] = [];
      if (args.dimension !== "event:props:destination_host") {
        errors.push(
          `Expected dimension "event:props:destination_host", got "${args.dimension}"`
        );
      }
      return errors;
    },
  },
  {
    name: "filter timeseries by a custom property value",
    prompt:
      "Show daily visitors to example.com over the last 30 days, but only for events where the custom property `plan` is `pro`.",
    expectedTool: "get_timeseries",
    assertions: (args) => {
      const errors: string[] = [];
      const filters = args.property_filters as
        | Array<{ property?: string; values?: string[] }>
        | undefined;
      const match = filters?.find(
        (f) => f.property === "plan" && (f.values ?? []).includes("pro")
      );
      if (!match) {
        errors.push(
          `Expected a property_filters entry for plan=pro, got ${JSON.stringify(args.property_filters)}`
        );
      }
      return errors;
    },
  },
  {
    name: "breakdown filtered by a visit-level dimension",
    prompt:
      "What are the top pages on example.com this month for visitors who arrived via the Organic Search channel?",
    expectedTool: "get_breakdown",
    assertions: (args) => {
      const errors: string[] = [];
      if (args.dimension !== "event:page") {
        errors.push(`Expected dimension "event:page", got "${args.dimension}"`);
      }
      const filters = args.property_filters as
        | Array<{ property?: string; values?: string[] }>
        | undefined;
      const match = filters?.find(
        (f) =>
          f.property === "visit:channel" &&
          (f.values ?? []).includes("Organic Search")
      );
      if (!match) {
        errors.push(
          `Expected a property_filters entry for visit:channel=Organic Search, got ${JSON.stringify(args.property_filters)}`
        );
      }
      return errors;
    },
  },
  {
    // From feedback PLAUSIBLE-MCP-V: an agent read conversion_rate, whose denominator is
    // every visitor in the query, as each row's own rate.
    name: "per-row conversion rate in a goal breakdown",
    prompt:
      "For the Purchase goal, what is the conversion rate of each entry page on example.com over the last 30 days?",
    expectedTool: "get_breakdown",
    assertions: (args) => {
      const errors: string[] = [];
      if (args.dimension !== "visit:entry_page") {
        errors.push(`Expected dimension "visit:entry_page", got "${args.dimension}"`);
      }
      if (!String(args.goal ?? "").toLowerCase().includes("purchase")) {
        errors.push(`Expected goal to contain "purchase", got "${args.goal}"`);
      }
      // Omitted metrics are fine: a goal breakdown defaults to group_conversion_rate.
      const metrics = args.metrics as string[] | undefined;
      if (metrics && !metrics.includes("group_conversion_rate")) {
        errors.push(
          `Expected metrics to include "group_conversion_rate", got ${JSON.stringify(metrics)}`
        );
      }
      return errors;
    },
  },
];

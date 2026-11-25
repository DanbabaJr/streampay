import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import ForecastSummary from "./ForecastSummary";
import StreamProjectionTable from "./StreamProjectionTable";
import TimeSeriesChart from "./TimeSeriesChart";
import {
  buildAggregatedTimeSeries,
  forecastIncome,
  windowFromDays,
  type AnalyticsStream,
} from "@/lib/analytics";
import { FIXED_NOW_SECONDS } from "../../.storybook/fake-clock";
import { TOKEN_CONTRACT, XLM_SAC, activeStream, tokenStream } from "../../.storybook/fixtures";

// Analytics inputs derived from the shared fixtures, and evaluated at the
// frozen instant rather than `Date.now()`, exactly as /analytics feeds them.
const STREAMS: AnalyticsStream[] = [activeStream, tokenStream].map((s) => ({
  id: s.id,
  token: s.token,
  deposit: BigInt(s.deposit),
  withdrawn: BigInt(s.withdrawn),
  startTime: s.startTime,
  endTime: s.endTime,
  status: s.status,
  symbol: s.token === XLM_SAC ? "XLM" : s.token === TOKEN_CONTRACT ? "USDC" : undefined,
}));

const [FROM, TO] = windowFromDays(FIXED_NOW_SECONDS, 14, 14);

/** The /analytics building blocks, fed by the pure functions in lib/analytics. */
const meta = {
  title: "Analytics/Charts",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const AccrualTimeSeries: StoryObj<typeof TimeSeriesChart> = {
  render: (args) => <TimeSeriesChart {...args} />,
  args: {
    title: "XLM accrued vs. claimed",
    points: buildAggregatedTimeSeries([STREAMS[0]], FROM, TO, 60),
  },
};

/** No points in the window: the chart's empty state. */
export const EmptyTimeSeries: StoryObj<typeof TimeSeriesChart> = {
  render: (args) => <TimeSeriesChart {...args} />,
  args: { title: "No activity", points: [] },
};

export const Forecast: StoryObj<typeof ForecastSummary> = {
  render: (args) => <ForecastSummary {...args} />,
  args: {
    forecast30: forecastIncome(STREAMS, FIXED_NOW_SECONDS, 30),
    forecast90: forecastIncome(STREAMS, FIXED_NOW_SECONDS, 90),
  },
};

export const Projections: StoryObj<typeof StreamProjectionTable> = {
  render: (args) => <StreamProjectionTable {...args} />,
  args: { streams: STREAMS, nowSeconds: FIXED_NOW_SECONDS },
};

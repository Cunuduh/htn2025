// agent role descriptors and system prompts
export const DEFAULT_URL = "https://www.foxnews.com/us/charlie-kirk-assassination-timeline-utah-campus-shooting-details-attack-manhunt-suspect";

export type AgentId =
  | "credibility"
  | "facts_vs_interpretation"
  | "cui_bono"
  | "omissions"
  | "rhetoric";

export interface AgentSpec {
  id: AgentId;
  name: string;
  system: string;
  allowSearch?: boolean; // only for fact verification pathways
}

// concise specialized system prompts
export const AGENT_SPECS: AgentSpec[] = [
  {
    id: "credibility",
    name: "Source Credibility",
    system: `Is this source trustworthy? Check who owns the publication, who wrote it, and where they got their information. Look for obvious bias or conflicts of interest. Keep it simple: **Who Published This**, **Where Info Came From**, **Any Red Flags**, **Can You Trust It?**`,
  },
  {
    id: "facts_vs_interpretation",
    name: "Facts vs Interpretation",
    system: `What actually happened vs what the writer thinks about it? Separate hard facts (names, dates, official statements) from opinions and speculation. Flag vague claims. Format: **What We Know for Sure**, **Writer's Opinions**, **Unclear Claims**.`,
    allowSearch: true,
  },
  {
    id: "cui_bono",
    name: "Who Benefits",
    system: `Who wants you to believe this story? Look for political timing, who gains power/money, or whose agenda this serves. Keep it short: **Who Wins**, **Why Now**, **Hidden Motives**.`,
  },
  {
    id: "omissions",
    name: "What's Missing",
    system: `What aren't they telling you? Look for missing context, ignored perspectives, or convenient omissions. Format: **Missing Facts**, **Other Side of Story**, **Important Context Left Out**.`,
    allowSearch: true,
  },
  {
    id: "rhetoric",
    name: "Emotional Tricks",
    system: `How are they trying to make you feel? Look for scary language, emotional manipulation, or unfair tactics. Format: **Emotional Language**, **Scare Tactics**, **Manipulation Attempts**.`,
  },
];

export const SUMMARY_SYSTEM = `Give a short, clear verdict for someone who doesn't follow news closely. Rate trustworthiness, highlight biggest concerns, explain what to double-check. Keep under 300 words total. Format: **Trust Level**, **Main Concerns**, **What to Verify**.`;
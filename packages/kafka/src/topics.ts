// Topic naming convention — VEKTOR-PRD.md §12.3: {env}.vektor.{domain}.{action}
export type VektorEnv = "dev" | "staging" | "prod";

export function topicName(env: VektorEnv, domain: string, action: string): string {
  return `${env}.vektor.${domain}.${action}`;
}

export const splitTopics = (topics: string | null) => [
  ...new Set(
    (topics ?? '')
      .split(/[,，、;；\n]+/)
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];

export function latestTopics(labels: Array<{ month: string; group: string | null; topics: string | null }>) {
  const month = labels.reduce((latest, row) => (row.month > latest ? row.month : latest), '');
  return [
    ...new Set(labels.filter((row) => row.month === month).flatMap((row) => [...splitTopics(row.group), ...splitTopics(row.topics)])),
  ];
}

export function componentUniqueNameAliases(uniqueName: string): string[] {
  const aliases = [uniqueName];
  if (/Blueprint$/i.test(uniqueName)) aliases.push(uniqueName.replace(/Blueprint$/i, "Component"));
  if (/Component$/i.test(uniqueName)) aliases.push(uniqueName.replace(/Component$/i, "Blueprint"));
  return aliases;
}

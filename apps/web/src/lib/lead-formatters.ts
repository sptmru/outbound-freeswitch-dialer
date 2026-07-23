export function getDisplayCompany(company: string | null | undefined): string {
  const value = company?.trim() ?? "";
  return value.toLowerCase() === "unmapped company" ? "" : value;
}

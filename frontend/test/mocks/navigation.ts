let mockPathname = "/";

export function setMockPathname(pathname: string) {
  mockPathname = pathname;
}

export function useRouter() {
  return { refresh: () => {}, push: () => {} };
}
export function usePathname() {
  return mockPathname;
}
export function useSearchParams() {
  return new URLSearchParams();
}

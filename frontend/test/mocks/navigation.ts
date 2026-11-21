export function useRouter() {
  return { refresh: () => {}, push: () => {} };
}
export function usePathname() {
  return "/";
}
export function useSearchParams() {
  return new URLSearchParams();
}

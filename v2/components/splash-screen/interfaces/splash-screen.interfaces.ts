export type SplashScreenStatus = "loading" | "failed" | "success";

export type SplashScreenEvent =
  | { kind: "loaded-success" }
  | { kind: "failed"; message: string };

export interface SplashScreenProps {
  title?: string;
  progress?: number;
  message?: string;
  errorMessage?: string;
  status?: SplashScreenStatus;
  loaded?: boolean;
  className?: string;
  onSuccess?: () => void;
  onEvent?: (event: SplashScreenEvent) => void;
}

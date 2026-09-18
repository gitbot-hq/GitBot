"use client";

import { useRouter } from "next/navigation";
import TopBar from "../components/top-bar";
import ThemeButton from "../v2/theme-button";
import OnboardingFlow from "../components/onboarding-flow";
import "../v2/v2-theme.css";
import "./onboarding.css";

// Standalone first-run route. The same flow also renders inside / (which
// is v2) whenever the user has no bots yet.
export default function Onboarding() {
  const router = useRouter();

  return (
    <div className="page v2">
      <TopBar actions={<ThemeButton />} />
      <div className="page-body">
        <OnboardingFlow onDone={() => router.push("/")} />
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { userInitials } from "../lib/user-prefs";
import MarketplaceVerifiedBadge from "./marketplace-verified-badge";

export default function MarketplaceAuthor({ name, photo, verified, caption }: {
  name: string;
  photo?: string;
  verified?: boolean;
  caption?: string;
}) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  return (
    <span className={`marketplace-author${photo?.startsWith("/favicon-") ? " marketplace-author-brand" : ""}`}>
      <span className="marketplace-author-avatar" aria-hidden="true">
        {photo && failedPhoto !== photo
          ? <img src={photo} alt="" width={80} height={80} onError={() => setFailedPhoto(photo)} />
          : userInitials(name)}
      </span>
      <span className="marketplace-author-copy">
        {caption && <span className="marketplace-author-caption">{caption}</span>}
        <span className="marketplace-author-identity">
          <span className="marketplace-author-name">{name}</span>
          {verified && <MarketplaceVerifiedBadge />}
        </span>
      </span>
    </span>
  );
}

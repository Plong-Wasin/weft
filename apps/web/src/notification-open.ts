import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { action } from "./api";
import { inboxNotificationIdFromSearch, withoutInboxNotificationId } from "./notification-target";

/** Each destination consumes the URL token once, after success or a definitive failed load. */
export function useInboxNotificationOpen() {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const notificationId = inboxNotificationIdFromSearch(location.search);
  const handledLocation = React.useRef<string | null>(null);
  const finish = React.useCallback((loaded: boolean) => {
    if (!notificationId || handledLocation.current === location.key) return;
    handledLocation.current = location.key;
    if (loaded && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notificationId)) {
      void action("mark_notification_read", { notificationId }).then((result) => {
        if (result) void client.invalidateQueries({ queryKey: ["inbox"] });
      });
    }
    navigate({ pathname: location.pathname, search: withoutInboxNotificationId(location.search), hash: location.hash }, { replace: true, state: null });
  }, [client, location.hash, location.key, location.pathname, location.search, navigate, notificationId]);
  return {
    notificationId,
    markLoaded: React.useCallback(() => finish(true), [finish]),
    markUnavailable: React.useCallback(() => finish(false), [finish]),
  };
}

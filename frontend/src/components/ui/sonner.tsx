"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({
  className,
  style,
  toastOptions,
  ...props
}: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className={cn("toaster group", className)}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--muted)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--pro-toast-border)",
          "--border-radius": "var(--radius)",
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        style: {
          borderWidth: "0.5px",
          boxShadow: "0 6px 22px #0007, 0 1px 3px #0004",
          fontFamily: "inherit",
          fontSize: "12px",
          ...toastOptions?.style,
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

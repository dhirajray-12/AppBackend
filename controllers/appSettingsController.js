const {
  DEFAULT_SERVER_NAME,
  HEX_COLOR_PATTERN,
  buildAccessPayload,
  getOrCreateAppSettings,
} = require("../services/suspensionService");
const {
  isValidTimezone,
  invalidateConfiguredTimezoneCache,
} = require("../utils/timezoneUtils");

exports.getAppSettings = async (req, res, next) => {
  try {
    const settings = await getOrCreateAppSettings();
    const payload = await buildAccessPayload({
      settingsDoc: settings,
      io: req.app.get("io"),
    });

    res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateAppSettings = async (req, res, next) => {
  try {
    const hasServerName = req.body?.serverName !== undefined;
    const hasTheme = req.body?.theme !== undefined;
    const hasTimezone = req.body?.timezone !== undefined;

    const nextServerName = hasServerName
      ? String(req.body.serverName || "").trim()
      : null;

    if (hasServerName && !nextServerName) {
      return res.status(400).json({
        success: false,
        message: "Server name is required",
      });
    }

    let nextThemeMode = null;
    let nextAccentColor = null;

    if (hasTheme) {
      const theme = req.body.theme || {};

      if (theme.mode !== undefined) {
        if (theme.mode !== "light" && theme.mode !== "dark") {
          return res.status(400).json({
            success: false,
            message: "Theme mode must be 'light' or 'dark'",
          });
        }
        nextThemeMode = theme.mode;
      }

      if (theme.accentColor !== undefined) {
        if (!HEX_COLOR_PATTERN.test(theme.accentColor)) {
          return res.status(400).json({
            success: false,
            message: "Accent color must be a hex value like #38bdf8",
          });
        }
        nextAccentColor = theme.accentColor;
      }
    }

    let nextTimezone = null;

    if (hasTimezone) {
      const timezone = String(req.body.timezone || "").trim();
      if (!isValidTimezone(timezone)) {
        return res.status(400).json({
          success: false,
          message: "Timezone must be a valid IANA timezone name, e.g. 'Asia/Kolkata'",
        });
      }
      nextTimezone = timezone;
    }

    if (!hasServerName && !hasTheme && !hasTimezone) {
      return res.status(400).json({
        success: false,
        message: "Nothing to update",
      });
    }

    const settings = await getOrCreateAppSettings();

    if (nextServerName) {
      settings.serverName = nextServerName;
    }
    if (nextThemeMode) {
      settings.theme.mode = nextThemeMode;
    }
    if (nextAccentColor) {
      settings.theme.accentColor = nextAccentColor;
    }
    if (nextTimezone) {
      settings.timezone = nextTimezone;
    }

    await settings.save();

    if (nextTimezone) {
      await invalidateConfiguredTimezoneCache();
    }
    const payload = await buildAccessPayload({
      settingsDoc: settings,
      io: req.app.get("io"),
    });

    const io = req.app.get("io");
    if (io) {
      io.emit("app_settings_updated", {
        ...payload,
        updatedAt: new Date().toISOString(),
      });
      if (nextTimezone && io.invalidateAllUsersCache) {
        io.invalidateAllUsersCache(["timezone"]);
      }
    }

    res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      data: payload,
    });
  } catch (error) {
    next(error);
  }
};

exports.getPublicAppStatus = async (req, res, next) => {
  try {
    const settings = await getOrCreateAppSettings();
    const payload = await buildAccessPayload({
      settingsDoc: settings,
      io: req.app.get("io"),
    });

    res.status(200).json({
      success: true,
      data: {
        serverName: payload.serverName || DEFAULT_SERVER_NAME,
        theme: payload.theme,
        timezone: payload.timezone,
        currentState: payload.currentState,
      },
    });
  } catch (error) {
    next(error);
  }
};

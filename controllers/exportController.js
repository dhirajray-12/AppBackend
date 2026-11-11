const Ticket = require("../models/Ticket");
const { exportToExcel, exportToPDF } = require("../utils/exportUtils");
const fs = require("fs");
const path = require("path");
const cacheService = require("../services/cacheService");
const { pipeline } = require("stream");
const { promisify } = require("util");
const unlinkAsync = promisify(fs.unlink);

// Cache keys
const CACHE_KEYS = {
  TICKETS_FOR_EXPORT: (filters) => `export:tickets:${JSON.stringify(filters)}`,
};

// Cache TTLs (in seconds)
const CACHE_TTL = {
  TICKETS_FOR_EXPORT: 60, // 1 minute - tickets data for export
};

// Temporary directory for export files
const EXPORT_TEMP_DIR = path.join(__dirname, "../temp/exports");

// Ensure temp directory exists
if (!fs.existsSync(EXPORT_TEMP_DIR)) {
  fs.mkdirSync(EXPORT_TEMP_DIR, { recursive: true });
}

// Helper to generate unique filename
const generateFilename = (format) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `tickets_export_${timestamp}_${random}.${format}`;
};

// Helper to get tickets data with caching
const getTicketsForExportCached = async (filters = {}) => {
  const cacheKey = CACHE_KEYS.TICKETS_FOR_EXPORT(filters);

  // Try to get from cache
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Build query
  const query = {};
  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }
  if (filters.category && filters.category !== "all") {
    query.category = filters.category;
  }
  if (filters.startDate && filters.endDate) {
    query.createdAt = {
      $gte: new Date(filters.startDate),
      $lte: new Date(filters.endDate),
    };
  }

  // Fetch tickets with lean() for better performance
  const tickets = await Ticket.find(query)
    .populate("createdBy", "firstName lastName email")
    .populate("assignedTo", "firstName lastName email")
    .sort({ createdAt: -1 })
    .lean();

  // Cache the result
  await cacheService.set(cacheKey, tickets, CACHE_TTL.TICKETS_FOR_EXPORT);

  return tickets;
};
// @desc    Export tickets
// @route   GET /api/tickets/export
// @access  Private (Admin/Agent only)
exports.exportTickets = async (req, res, next) => {
  try {
    const {
      format,
      status,
      category,
      startDate,
      endDate,
      limit = 10000, // Max rows to export
    } = req.query;

    // Validate format
    if (!format || (format !== "xlsx" && format !== "pdf")) {
      return res.status(400).json({
        success: false,
        message: "Invalid export format. Use xlsx or pdf",
      });
    }

    // Build filters for caching
    const filters = { status, category, startDate, endDate };

    // Get tickets with caching
    let tickets = await getTicketsForExportCached(filters);

    // Apply limit if needed
    if (tickets.length > parseInt(limit)) {
      tickets = tickets.slice(0, parseInt(limit));
    }

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No tickets found to export",
      });
    }

    // Generate unique filename
    const filename = generateFilename(format);
    const filePath = path.join(EXPORT_TEMP_DIR, filename);

    // Generate export based on format
    let result;
    if (format === "xlsx") {
      result = await exportToExcelStream(tickets, filePath);
    } else {
      result = await exportToPDFStream(tickets, filePath);
    }

    // Set response headers
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    if (format === "xlsx") {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    } else {
      res.setHeader("Content-Type", "application/pdf");
    }

    // Stream file to response with cleanup
    const fileStream = fs.createReadStream(filePath);

    fileStream.on("end", async () => {
      // Clean up temp file after streaming
      try {
        await unlinkAsync(filePath);
      } catch (err) {
        console.error("Error deleting export file:", err);
      }
    });

    fileStream.on("error", async (err) => {
      console.error("Error streaming export file:", err);
      try {
        await unlinkAsync(filePath);
      } catch (unlinkErr) {
        console.error("Error deleting export file after error:", unlinkErr);
      }

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Export failed while streaming file",
        });
      } else {
        res.destroy();
      }
    });

    fileStream.pipe(res);
  } catch (error) {
    next(error);
  }
};
// Stream Excel export to file (memory efficient)
const exportToExcelStream = async (tickets, filePath) => {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Tickets");

  // Define columns
  worksheet.columns = [
    { header: "Ticket #", key: "ticketNumber", width: 15 },
    { header: "Subject", key: "subject", width: 30 },
    { header: "Category", key: "category", width: 15 },
    { header: "Status", key: "status", width: 12 },
    { header: "Priority", key: "priority", width: 10 },
    { header: "Created By", key: "createdByName", width: 20 },
    { header: "Created By Email", key: "createdByEmail", width: 25 },
    { header: "Assigned To", key: "assignedToName", width: 20 },
    { header: "Created At", key: "createdAt", width: 20 },
    { header: "Updated At", key: "updatedAt", width: 20 },
    { header: "Description", key: "description", width: 50 },
  ];

  // Style header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE0E0E0" },
  };

  // Add data rows in batches for memory efficiency
  const batchSize = 1000;
  for (let i = 0; i < tickets.length; i += batchSize) {
    const batch = tickets.slice(i, i + batchSize);
    const rows = batch.map((ticket) => ({
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority || "medium",
      createdByName: ticket.createdBy
        ? `${ticket.createdBy.firstName || ""} ${ticket.createdBy.lastName || ""}`.trim()
        : "N/A",
      createdByEmail: ticket.createdBy?.email || "N/A",
      assignedToName: ticket.assignedTo
        ? `${ticket.assignedTo.firstName || ""} ${ticket.assignedTo.lastName || ""}`.trim()
        : "Unassigned",
      createdAt: ticket.createdAt
        ? new Date(ticket.createdAt).toLocaleString()
        : "N/A",
      updatedAt: ticket.updatedAt
        ? new Date(ticket.updatedAt).toLocaleString()
        : "N/A",
      description: ticket.description?.substring(0, 500) || "",
    }));
    worksheet.addRows(rows);
  }

  // Write to file
  await workbook.xlsx.writeFile(filePath);

  return { filePath, filename: path.basename(filePath) };
};
// Stream PDF export to file (memory efficient)
const exportToPDFStream = async (tickets, filePath) => {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });

  // Create write stream
  const writeStream = fs.createWriteStream(filePath);
  doc.pipe(writeStream);

  // Add title
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("Tickets Report", { align: "center" });
  doc.moveDown();

  // Add generation date
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(`Generated on: ${new Date().toLocaleString()}`, { align: "right" });
  doc.moveDown(2);

  // Table configuration
  const tableHeaders = [
    "Ticket #",
    "Subject",
    "Category",
    "Status",
    "Created By",
    "Created At",
  ];
  const colWidths = [80, 120, 80, 70, 100, 100];
  const lineHeight = 20;
  const startY = doc.y;

  // Draw header
  let currentX = doc.page.margins.left;
  doc.font("Helvetica-Bold").fontSize(9);

  // Header background
  doc
    .rect(
      currentX,
      startY,
      colWidths.reduce((a, b) => a + b, 0),
      lineHeight,
    )
    .fill("#E0E0E0");

  tableHeaders.forEach((header, i) => {
    doc.fillColor("black").text(header, currentX + 5, startY + 5, {
      width: colWidths[i] - 10,
      align: "center",
    });
    currentX += colWidths[i];
  });

  let currentY = startY + lineHeight;

  // Draw rows
  for (let i = 0; i < Math.min(tickets.length, 500); i++) {
    // Limit to 500 rows for PDF
    const ticket = tickets[i];

    // Check for page break
    if (currentY > doc.page.height - doc.page.margins.bottom - 50) {
      doc.addPage({ layout: "landscape" });
      currentY = doc.page.margins.top;

      // Redraw header on new page
      currentX = doc.page.margins.left;
      doc
        .rect(
          currentX,
          currentY,
          colWidths.reduce((a, b) => a + b, 0),
          lineHeight,
        )
        .fill("#E0E0E0");
      tableHeaders.forEach((header, idx) => {
        doc.fillColor("black").text(header, currentX + 5, currentY + 5, {
          width: colWidths[idx] - 10,
          align: "center",
        });
        currentX += colWidths[idx];
      });
      currentY += lineHeight;
    }

    // Row background (alternating colors)
    const isEven = i % 2 === 0;
    doc
      .rect(
        doc.page.margins.left,
        currentY,
        colWidths.reduce((a, b) => a + b, 0),
        lineHeight,
      )
      .fill(isEven ? "#FFFFFF" : "#F9F9F9");

    // Row data
    currentX = doc.page.margins.left;
    doc.font("Helvetica").fontSize(8).fillColor("black");

    const rowData = [
      ticket.ticketNumber || "N/A",
      (ticket.subject || "").substring(0, 30),
      ticket.category || "N/A",
      ticket.status || "N/A",
      ticket.createdBy
        ? `${ticket.createdBy.firstName || ""} ${ticket.createdBy.lastName || ""}`.trim()
        : "N/A",
      ticket.createdAt
        ? new Date(ticket.createdAt).toLocaleDateString()
        : "N/A",
    ];

    rowData.forEach((data, idx) => {
      doc.text(data.toString(), currentX + 5, currentY + 5, {
        width: colWidths[idx] - 10,
      });
      currentX += colWidths[idx];
    });

    currentY += lineHeight;
  }

  // Add page numbers
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc
      .fontSize(8)
      .fillColor("#666666")
      .text(
        `Page ${i + 1} of ${pageCount}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom - 20,
        {
          align: "center",
          width:
            doc.page.width - doc.page.margins.left - doc.page.margins.right,
        },
      );
  }

  doc.end();

  // Wait for write stream to finish
  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  return { filePath, filename: path.basename(filePath) };
};
// @desc    Export tickets with advanced filters
// @route   POST /api/tickets/export/filtered
// @access  Private (Admin/Agent only)
exports.exportTicketsFiltered = async (req, res, next) => {
  try {
    const {
      format,
      status,
      category,
      startDate,
      endDate,
      limit = 10000,
    } = req.body;

    if (!format || (format !== "xlsx" && format !== "pdf")) {
      return res.status(400).json({
        success: false,
        message: "Invalid export format. Use xlsx or pdf",
      });
    }

    // Build query
    const query = {};
    if (status && status !== "all") query.status = status;
    if (category && category !== "all") query.category = category;
    if (startDate && endDate) {
      query.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    // Fetch tickets with lean()
    let tickets = await Ticket.find(query)
      .populate("createdBy", "firstName lastName email")
      .populate("assignedTo", "firstName lastName email")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    if (tickets.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No tickets found to export",
      });
    }

    const filename = generateFilename(format);
    const filePath = path.join(EXPORT_TEMP_DIR, filename);

    let result;
    if (format === "xlsx") {
      result = await exportToExcelStream(tickets, filePath);
    } else {
      result = await exportToPDFStream(tickets, filePath);
    }

    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.setHeader(
      "Content-Type",
      format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/pdf",
    );

    const fileStream = fs.createReadStream(filePath);
    fileStream.on("end", async () => {
      try {
        await unlinkAsync(filePath);
      } catch (err) {
        console.error("Error deleting export file:", err);
      }
    });
    fileStream.on("error", async (err) => {
      console.error("Error streaming filtered export file:", err);
      try {
        await unlinkAsync(filePath);
      } catch (unlinkErr) {
        console.error("Error deleting export file after error:", unlinkErr);
      }

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Export failed while streaming file",
        });
      } else {
        res.destroy();
      }
    });
    fileStream.pipe(res);
  } catch (error) {
    next(error);
  }
};
// @desc    Get available export options (statuses, categories)
// @route   GET /api/tickets/export/options
// @access  Private (Admin/Agent only)
exports.getExportOptions = async (req, res, next) => {
  try {
    const cacheKey = "export:tickets:options";

    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        fromCache: true,
      });
    }

    const [statuses, categories] = await Promise.all([
      Ticket.distinct("status"),
      Ticket.distinct("category"),
    ]);

    const options = {
      statuses: ["all", ...statuses.filter((s) => s !== "all")],
      categories: ["all", ...categories.filter((c) => c !== "all")],
      formats: ["xlsx", "pdf"],
      maxRows: 10000,
    };

    await cacheService.set(cacheKey, options, 3600); // 1 hour cache

    res.json({
      success: true,
      data: options,
    });
  } catch (error) {
    next(error);
  }
};
// Clean up export files older than 1 hour
const cleanupOldExportFiles = async () => {
  try {
    const files = fs.readdirSync(EXPORT_TEMP_DIR);
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(EXPORT_TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < oneHourAgo) {
        await unlinkAsync(filePath);
      }
    }
  } catch (error) {
    console.error("Cleanup export files error:", error);
  }
};

// Run cleanup every hour
setInterval(cleanupOldExportFiles, 60 * 60 * 1000);

// Export helper functions
exports.exportToExcelStream = exportToExcelStream;
exports.exportToPDFStream = exportToPDFStream;

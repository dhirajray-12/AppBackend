const express = require("express");
const router = express.Router();
const { protect } = require("../../middlewares/auth");
const {
  getAssistantContext,
  chatWithAssistant,
} = require("../../controllers/client/assistantController");

router.use(protect);

router.get("/context", getAssistantContext);
router.post("/chat", chatWithAssistant);

module.exports = router;
import { z } from "zod";

export const signupSchema = z.object({
  firstName: z
    .string()
    .min(3, "Minimum 3 characters")
    .nonempty("First name is required"),
  lastName: z
    .string()
    .min(3, "Minimum 3 characters")
    .nonempty("Last name is required"),
  email: z.string().email("Invalid email"),
  password: z.string().min(6, "Minimum 6 characters"),
  phone: z
    .string()
    .regex(/^\d+$/, "Phone number must contain digits only (no '+' sign)")
    .min(5, "Minimum 5 digits for phone number")
    .max(18, "Maximum 18 digits for phone number (country code + number)"),
  zipCode: z.string().min(4, "Zip code required"),
  state: z.string().min(2, "State required"),
  dateofbirth: z.date().min(new Date("1900-01-01"), "Invalid date of birth"),
  country: z.string().min(1, "Country required"),
  referralCode: z.string().optional(),
});

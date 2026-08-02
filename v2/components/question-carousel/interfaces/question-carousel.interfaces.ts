export interface QuestionOption { label: string; value?: string; }
export interface CarouselQuestion { id: string; prompt: string; options?: QuestionOption[]; }
export interface QuestionAnswer { questionId: string; prompt: string; answer: string; }
export interface QuestionCarouselProps {
  title?: string;
  questions: CarouselQuestion[];
  onSubmit: (answers: QuestionAnswer[]) => void;
}

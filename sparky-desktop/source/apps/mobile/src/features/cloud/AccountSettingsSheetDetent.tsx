import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface AccountSettingsSheetDetentValue {
  collapse: () => void;
  expand: () => void;
  isExpanded: boolean;
}

const AccountSettingsSheetDetentContext = createContext<AccountSettingsSheetDetentValue | null>(null);

interface AccountSettingsSheetDetentProviderProps extends PropsWithChildren {
  initiallyExpanded: boolean;
}

export function AccountSettingsSheetDetentProvider({
  children,
  initiallyExpanded,
}: AccountSettingsSheetDetentProviderProps) {
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);
  const collapse = useCallback(() => setIsExpanded(false), []);
  const expand = useCallback(() => setIsExpanded(true), []);
  const value = useMemo(() => ({ collapse, expand, isExpanded }), [collapse, expand, isExpanded]);

  return (
    <AccountSettingsSheetDetentContext value={value}>{children}</AccountSettingsSheetDetentContext>
  );
}

export function useAccountSettingsSheetDetent(): AccountSettingsSheetDetentValue {
  const value = useContext(AccountSettingsSheetDetentContext);
  if (!value) {
    throw new Error(
      "useAccountSettingsSheetDetent must be used inside AccountSettingsSheetDetentProvider",
    );
  }
  return value;
}

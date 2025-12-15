import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, Medal, Rocket, Users, FolderKanban, Loader2, DollarSign, Coins, AlertCircle, Calendar } from "lucide-react";
import csrfService from "@/lib/csrf";
import { STAGING_API_URL } from "@/config";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Types for Leaderboard Data
interface Contributor {
    rank: number;
    id: number;
    username: string;
    avatarUrl: string | null;
    roxnEarned: string;
    usdcEarned: string;
}

interface Project {
    rank: number;
    id: number;
    name: string;
    avatarUrl: string;
    bountiesCount: number;
}

// Animation Variants
const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: { staggerChildren: 0.1 },
    },
};

const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
};

export default function LeaderboardPage() {
    const [activeTab, setActiveTab] = useState("contributors");

    // Fetch Contributors Data
    const { data: contributors, isLoading: isLoadingContributors, error: contributorsError } = useQuery<Contributor[]>({
        queryKey: ["leaderboard", "contributors"],
        queryFn: async () => {
            const csrfToken = await csrfService.getToken();
            const res = await fetch(`${STAGING_API_URL}/api/leaderboard/contributors`, {
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'X-CSRF-Token': csrfToken
                }
            });
            if (!res.ok) throw new Error("Failed to fetch contributors");
            return res.json();
        },
    });

    // Fetch Projects Data
    const { data: projects, isLoading: isLoadingProjects, error: projectsError } = useQuery<Project[]>({
        queryKey: ["leaderboard", "projects"],
        queryFn: async () => {
            const csrfToken = await csrfService.getToken();
            const res = await fetch(`${STAGING_API_URL}/api/leaderboard/projects`, {
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'X-CSRF-Token': csrfToken
                }
            });
            if (!res.ok) throw new Error("Failed to fetch projects");
            return res.json();
        },
    });

    const getRankIcon = (rank: number) => {
        switch (rank) {
            case 1:
                return <Trophy className="w-6 h-6 text-yellow-500" />;
            case 2:
                return <Medal className="w-6 h-6 text-gray-400" />;
            case 3:
                return <Medal className="w-6 h-6 text-amber-700" />;
            default:
                return <span className="font-bold text-muted-foreground w-6 text-center">{rank}</span>;
        }
    };

    const getRankColor = (rank: number) => {
        switch (rank) {
            case 1: return "bg-yellow-500/10 border-yellow-500/50 hover:shadow-yellow-500/20";
            case 2: return "bg-gray-400/10 border-gray-400/50 hover:shadow-gray-400/20";
            case 3: return "bg-amber-700/10 border-amber-700/50 hover:shadow-amber-700/20";
            default: return "bg-card hover:bg-card/80 border-border";
        }
    };

    return (
        <div className="min-h-screen bg-background noise-bg p-4 sm:p-8">
            <div className="max-w-5xl mx-auto space-y-8">

                {/* Header Section */}
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6 }}
                    className="text-center space-y-4"
                >
                    <h1 className="text-4xl sm:text-6xl font-black tracking-tight">
                        <span className="bg-clip-text text-transparent bg-gradient-to-r from-primary to-purple-600">
                            Leaderboard
                        </span>
                    </h1>
                    <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                        Discover the top contributors shaping the future of Roxonn and the most active projects driving innovation.
                    </p>
                </motion.div>

                {/* Time Filter - MVP Requirement */}
                <div className="flex justify-end">
                    <Select defaultValue="all-time">
                        <SelectTrigger className="w-[180px]">
                            <Calendar className="w-4 h-4 mr-2" />
                            <SelectValue placeholder="Select period" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all-time">All Time</SelectItem>
                            <SelectItem value="last-30-days" disabled>Last 30 Days (Coming Soon)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* Tabs Section */}
                <Tabs defaultValue="contributors" className="w-full" onValueChange={setActiveTab}>
                    <div className="flex justify-center mb-8">
                        <TabsList className="grid w-full max-w-md grid-cols-2 p-1">
                            <TabsTrigger value="contributors" className="text-base">
                                <Users className="w-4 h-4 mr-2" />
                                Top Contributors
                            </TabsTrigger>
                            <TabsTrigger value="projects" className="text-base">
                                <FolderKanban className="w-4 h-4 mr-2" />
                                Top Projects
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="contributors">
                        {isLoadingContributors ? (
                            <div className="flex justify-center py-20">
                                <Loader2 className="w-10 h-10 animate-spin text-primary" />
                            </div>
                        ) : contributorsError ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
                                <AlertCircle className="w-10 h-10 mb-4 text-destructive" />
                                <p>Failed to load contributors.</p>
                            </div>
                        ) : contributors?.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
                                <Users className="w-10 h-10 mb-4 opacity-20" />
                                <p>No contributors found yet.</p>
                            </div>
                        ) : (
                            <motion.div
                                variants={containerVariants}
                                initial="hidden"
                                animate="visible"
                                className="grid gap-4"
                            >
                                {contributors?.map((contributor) => (
                                    <motion.div key={contributor.id} variants={itemVariants}>
                                        <Card className={`transition-all duration-300 border ${getRankColor(contributor.rank)}`}>
                                            <CardContent className="flex items-center justify-between p-6">
                                                <div className="flex items-center gap-6">
                                                    <div className="flex-shrink-0 flex items-center justify-center w-12">
                                                        {getRankIcon(contributor.rank)}
                                                    </div>

                                                    <div className="flex items-center gap-4">
                                                        <Avatar className="w-12 h-12 border-2 border-background ring-2 ring-primary/20">
                                                            <AvatarImage src={contributor.avatarUrl || `https://github.com/${contributor.username}.png`} />
                                                            <AvatarFallback>{contributor.username.substring(0, 2).toUpperCase()}</AvatarFallback>
                                                        </Avatar>
                                                        <div>
                                                            <h3 className="font-bold text-lg">{contributor.username}</h3>
                                                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                                                <Badge variant="outline" className="text-xs font-normal">Contributor</Badge>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-6">
                                                    <div className="text-right hidden sm:block">
                                                        <p className="text-xs text-muted-foreground font-mono mb-1">Total Earned</p>
                                                        <div className="flex flex-col gap-1 items-end">
                                                            <span className="flex items-center gap-1 font-mono font-bold text-purple-400">
                                                                <Coins className="w-3 h-3" /> {contributor.roxnEarned} ROXN
                                                            </span>
                                                            <span className="flex items-center gap-1 font-mono font-bold text-green-400">
                                                                <DollarSign className="w-3 h-3" /> {contributor.usdcEarned} USDC
                                                            </span>
                                                        </div>
                                                    </div>
                                                    {/* Mobile View Summary */}
                                                    <div className="text-right sm:hidden">
                                                        <div className="flex flex-col gap-1 items-end">
                                                            <span className="flex items-center gap-1 font-mono font-bold text-purple-400 text-sm">
                                                                <Coins className="w-3 h-3" /> {contributor.roxnEarned} ROXN
                                                            </span>
                                                            <span className="flex items-center gap-1 font-mono font-bold text-green-400 text-sm">
                                                                <DollarSign className="w-3 h-3" /> {contributor.usdcEarned} USDC
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </motion.div>
                                ))}
                            </motion.div>
                        )}
                    </TabsContent>

                    <TabsContent value="projects">
                        {isLoadingProjects ? (
                            <div className="flex justify-center py-20">
                                <Loader2 className="w-10 h-10 animate-spin text-primary" />
                            </div>
                        ) : projectsError ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
                                <AlertCircle className="w-10 h-10 mb-4 text-destructive" />
                                <p>Failed to load projects.</p>
                            </div>
                        ) : projects?.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
                                <FolderKanban className="w-10 h-10 mb-4 opacity-20" />
                                <p>No projects found yet.</p>
                            </div>
                        ) : (
                            <motion.div
                                variants={containerVariants}
                                initial="hidden"
                                animate="visible"
                                className="grid gap-4"
                            >
                                {projects?.map((project) => (
                                    <motion.div key={project.id} variants={itemVariants}>
                                        <Card className={`transition-all duration-300 border ${getRankColor(project.rank)}`}>
                                            <CardContent className="flex items-center justify-between p-6">
                                                <div className="flex items-center gap-6">
                                                    <div className="flex-shrink-0 flex items-center justify-center w-12">
                                                        {getRankIcon(project.rank)}
                                                    </div>

                                                    <div className="flex items-center gap-4">
                                                        <Avatar className="w-12 h-12 rounded-lg border-2 border-background ring-2 ring-blue-500/20">
                                                            <AvatarImage src={project.avatarUrl} className="rounded-lg" />
                                                            <AvatarFallback className="rounded-lg">{project.name.substring(0, 2).toUpperCase()}</AvatarFallback>
                                                        </Avatar>
                                                        <div>
                                                            <h3 className="font-bold text-lg">{project.name}</h3>
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-6">
                                                    <div className="text-right">
                                                        <p className="text-xs text-muted-foreground font-mono mb-1">Active Bounties</p>
                                                        <div className="flex items-center justify-end gap-2">
                                                            <Rocket className="w-4 h-4 text-blue-400" />
                                                            <span className="font-bold text-xl">{project.bountiesCount}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </motion.div>
                                ))}
                            </motion.div>
                        )}
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
}
